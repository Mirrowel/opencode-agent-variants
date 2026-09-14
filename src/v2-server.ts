/**
 * OpenCode v2 server plugin implementation.
 *
 * v2 replaces the v1 config hook with replayable agent transforms and the
 * chat.message/chat.params hook pair with the `session.context` request hook.
 * Agent Variants maps onto that contract as follows:
 *
 * - Every variant alias becomes a REAL agent (a full copy of its parent with
 *   overridden fields — never a delegating wrapper). The subagent tool
 *   resolves `agent.model` structurally, so no call correlation is needed and
 *   the stored task input keeps the visible alias the model chose.
 * - Profiles (resolved per primary session, so they cannot be baked into a
 *   shared agent definition) get hidden per-model clone agents
 *   (`av:<alias>@<profile>`). `tool.execute.before` rewrites `input.agent`
 *   from the visible alias (or plain parent, for base task calls) to the
 *   clone matching the currently active profile.
 * - Request parameters (temperature/top_p/provider options) cannot ride on
 *   agent definitions in v2 (`agent.request` is currently inert on the wire),
 *   so they are applied per request through `session.context`, keyed by the
 *   executing agent id — which doubles as the route key.
 * - The sidecar is hot-reloaded: the agent transform re-reads it on every
 *   replay, and a directory watcher triggers `ctx.agent.reload()` so
 *   structural changes apply live instead of requiring a restart.
 *
 * v1 parity notes: profile parent patches compose into variant execution the
 * same way v1's liveRoute does — effectiveVariantPatch(overlay(parent,
 * profile.parent), overlay(variant, profile.variant)) — and profile parent
 * model patches also apply to base task calls of agents without variants.
 *
 * The v1 implementation (index.ts) is untouched; both share the pure config
 * helpers from config.ts.
 */

import { appendFileSync, unwatchFile, watch as fsWatch, watchFile as fsWatchFile } from "node:fs"
import { basename, dirname } from "node:path"
import {
  applyModelPresetPatch,
  applyPromptPatch,
  applyTextPatch,
  defaultConfigDir,
  defaultSidecarPath,
  debugLogPath,
  effectiveVariantPatch,
  emptyConfig,
  generatedParentDescription,
  generatedVariantDescription,
  hasPromptPatch,
  loadSidecar,
  overlayProfilePatch,
  profileParentPatch,
  profileVariantPatch,
  resolveActiveProfile,
  resolveModel,
  splitModelRef,
  templateContext,
  validateModelShape,
  variantName,
  type AgentPatch,
  type Diagnostic,
  type ProfilePatch,
  type SidecarConfig,
  type VariantConfig,
} from "./config.js"
import type {
  V2AgentEditor,
  V2AgentInfo,
  V2ExecuteAfterEvent,
  V2ExecuteBeforeEvent,
  V2ModelRef,
  V2PluginContext,
  V2Registration,
  V2ServerSetup,
  V2SessionContextEvent,
  V2SessionInfo,
} from "./v2-types.js"

const CLONE_PREFIX = "av:"
const SIDE_RELOAD_DEBOUNCE_MS = 300
const SESSION_CALL_TIMEOUT_MS = 3000
const SESSION_CACHE_TTL_MS = 10_000
const SESSION_CACHE_MAX = 128
const ROOT_WALK_MAX_DEPTH = 8

/** Route for one executable agent id (visible alias or hidden profile clone). */
export type V2Route = {
  alias: string
  parent: string
  key: string
  /** Agent id that executes this route (visible alias or `av:` clone). */
  execAgent: string
  /** Profile whose overlay shaped this route; undefined for the visible alias. */
  profile?: string
  /** Effective hot patch (composed and profile-overlaid for clones). */
  patch: AgentPatch
  /** Raw parent patch (sidecar `agents.<parent>.parent`) for recomposition. */
  rawParentPatch: AgentPatch
  /** Raw variant config for recomposition under a live profile overlay. */
  rawVariant: VariantConfig
  /** Parent's own system prompt when it is static (composed system is baked in). */
  parentSystem?: string
  /** Prompt patch must be applied at request time over the dynamic default. */
  promptRuntime: boolean
  /** Description used for the visible entry (reused by hidden clones). */
  description: string
}

export type V2ParentRoute = {
  parent: string
  /** Global parent hot patch (model/color/description applied to the parent definition at assembly). */
  patch: AgentPatch
  /** Parent has no static system; prompt patches apply at request time. */
  promptRuntime: boolean
}

export type V2Assembly = {
  /** Executing agent id → route. */
  routes: Map<string, V2Route>
  /** Visible alias → default route. */
  aliases: Map<string, V2Route>
  /** Parent agent id → global parent patch route. */
  parents: Map<string, V2ParentRoute>
  /** Hidden parent clone id (`av:parent@profile`) → parent id. */
  parentClones: Map<string, string>
  /**
   * Sidecar-managed parents whose BASE is hidden (sidecar disable_base OR a
   * hidden parent definition): fresh direct calls are rejected with the
   * enabled-variant list; resumes stay allowed. Only populated for parents
   * with at least one enabled variant (config-hidden alone never applies to
   * agent definitions AV does not manage).
   */
  hiddenBaseParents: Set<string>
  diagnostics: Diagnostic[]
}

export function variantCloneId(alias: string, profile: string) {
  return `${CLONE_PREFIX}${alias}@${profile}`
}

export function parentCloneId(parent: string, profile: string) {
  return `${CLONE_PREFIX}${parent}@${profile}`
}

function emptyAssembly(): V2Assembly {
  return { routes: new Map(), aliases: new Map(), parents: new Map(), parentClones: new Map(), hiddenBaseParents: new Set(), diagnostics: [] }
}

function modelRefOf(patch: AgentPatch, sidecar: SidecarConfig): V2ModelRef | undefined {
  const resolved = splitModelRef(resolveModel(patch.model, sidecar))
  if (!resolved) return undefined
  return { providerID: resolved.providerID, id: resolved.modelID, variant: patch.variant }
}

/**
 * The model ref a patch EFFECTIVELY selects, falling back to the parent's
 * model (with the patch's variant stamped over it) exactly like the agent
 * definition the patch produces. Clone decisions must compare these effective
 * refs — comparing raw patch refs would silently drop variant-only overlays.
 */
function effectiveModelRef(patch: AgentPatch, sidecar: SidecarConfig, parentModel?: V2ModelRef): V2ModelRef | undefined {
  const ref = modelRefOf(patch, sidecar)
  if (ref) return ref
  if (!parentModel) return undefined
  if (patch.variant !== undefined) return { ...parentModel, variant: patch.variant }
  return { ...parentModel }
}

function sameModelRef(a: V2ModelRef | undefined, b: V2ModelRef | undefined) {
  if (!a || !b) return a === b
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "")
}

/**
 * v1 liveRoute composition: parent patch overlaid with the profile parent
 * patch, variant overlaid with the profile variant patch, then merged via
 * the propagate/inherit rules, then model presets resolved.
 */
export function composeVariantPatch(
  rawParentPatch: AgentPatch,
  profileParent: ProfilePatch | undefined,
  rawVariant: VariantConfig,
  profileVariant: ProfilePatch | undefined,
  sidecar: SidecarConfig,
): AgentPatch {
  const parent = overlayProfilePatch(rawParentPatch, profileParent)
  const variant = overlayProfilePatch(rawVariant as unknown as AgentPatch, profileVariant) as VariantConfig
  return applyModelPresetPatch(effectiveVariantPatch(parent, variant), sidecar)
}

function hasRequestPatch(patch: AgentPatch) {
  return patch.temperature !== undefined || patch.top_p !== undefined || patch.options !== undefined
}

function safeSidecar(): SidecarConfig {
  try {
    return loadSidecar(defaultSidecarPath())
  } catch {
    return emptyConfig()
  }
}

function debugLog(message: string) {
  try {
    if (!safeSidecar().debug) return
    appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging must never affect routing.
  }
}

function logDiagnostics(diagnostics: Diagnostic[]) {
  for (const diagnostic of diagnostics) {
    if (diagnostic.level === "info") continue
    debugLog(`AGENT-VARIANTS ${diagnostic.level.toUpperCase()}: ${diagnostic.message}`)
  }
}

function stripLegacyMarkers(text: string) {
  return text
    .replace(/<!--\s*agent-variants-route[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function applyAgentModel(agent: V2AgentInfo, patch: AgentPatch, sidecar: SidecarConfig, fallback?: V2ModelRef) {
  const ref = effectiveModelRef(patch, sidecar, fallback)
  if (ref) {
    agent.model = { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
    return
  }
  if (fallback) agent.model = { ...fallback }
}

function copyRequest(target: V2AgentInfo, source: V2AgentInfo) {
  target.request = {
    settings: { ...source.request.settings },
    headers: { ...source.request.headers },
    body: { ...source.request.body },
  }
}

/**
 * Registers one variant execution agent (visible alias or hidden profile
 * clone) as a full copy of its parent with the effective patch applied.
 * Permissions, steps, and the request block are inherited from the parent
 * verbatim; the system prompt is composed and baked when the parent has a
 * static one.
 */
function registerClone(
  editor: V2AgentEditor,
  input: {
    id: string
    alias: string
    hidden: boolean
    name: string
    description: string
    parentInfo: V2AgentInfo
    patch: AgentPatch
    rawParentPatch: AgentPatch
    rawVariant: VariantConfig
    sidecar: SidecarConfig
    parent: string
    key: string
    profile?: string
  },
): V2Route {
  const { id, alias, hidden, name, description, parentInfo, patch, rawParentPatch, rawVariant, sidecar, parent, key, profile } = input
  const parentSystem = parentInfo.system
  const canBakeSystem = parentSystem !== undefined
  const composed = canBakeSystem && hasPromptPatch(patch) ? applyPromptPatch(parentSystem, patch, templateContext(parent, key, patch, sidecar)) : undefined
  editor.update(id, (agent) => {
    agent.mode = "subagent"
    agent.hidden = hidden
    agent.name = name
    agent.description = description
    applyAgentModel(agent, patch, sidecar, parentInfo.model ? { ...parentInfo.model } : undefined)
    if (parentSystem !== undefined) {
      agent.system = composed ?? parentSystem
    }
    if (Array.isArray(parentInfo.permissions)) agent.permissions = [...parentInfo.permissions]
    if (parentInfo.steps !== undefined) agent.steps = parentInfo.steps
    copyRequest(agent, parentInfo)
    const color = patch.color ?? parentInfo.color
    if (color !== undefined) agent.color = color
  })
  return {
    alias,
    parent,
    key,
    execAgent: id,
    profile,
    patch,
    rawParentPatch,
    rawVariant,
    parentSystem: canBakeSystem ? parentSystem : undefined,
    promptRuntime: !canBakeSystem && hasPromptPatch(patch),
    description,
  }
}

/**
 * Builds the full v2 agent graph for the current sidecar: parent patches,
 * visible alias clones, hidden per-profile clones, and the route tables the
 * runtime hooks key off. Exposed for regression tests with a stub editor.
 */
export function assembleV2Agents(editor: V2AgentEditor, sidecar: SidecarConfig): V2Assembly {
  const assembly = emptyAssembly()
  const generatedAliases = new Map<string, string>()

  // Parents include agents referenced only by profile overlays: v1 applied
  // profile parent patches to base task calls of variant-less agents too.
  const parentKeys = new Set<string>(Object.keys(sidecar.agents))
  for (const profile of Object.values(sidecar.profiles)) {
    for (const agent of Object.keys(profile.agents)) parentKeys.add(agent)
  }

  for (const parent of parentKeys) {
    const entry = sidecar.agents[parent]
    if (entry?.disable) {
      assembly.diagnostics.push({ level: "info", agent: parent, message: `Parent "${parent}" is disabled in sidecar config.` })
      continue
    }
    const parentInfo = editor.get(parent)
    if (!parentInfo) {
      assembly.diagnostics.push({ level: "warning", agent: parent, message: `Parent agent "${parent}" was not found; variants skipped.` })
      continue
    }
    if (parentInfo.mode === "primary") {
      assembly.diagnostics.push({
        level: "warning",
        agent: parent,
        message: `Parent agent "${parent}" is primary-only; variants may not be callable by the subagent tool unless the wizard filter was intentionally disabled.`,
      })
    }

    const enabledVariants = Object.entries(entry?.variants ?? {}).filter(([, variant]) => variant.disable !== true)
    const rawParentPatch = entry ? entry.parent : {}
    const parentPatchPreset = applyModelPresetPatch(rawParentPatch, sidecar)
    const parentShapeIssue = validateModelShape(parentPatchPreset.model, sidecar)
    let parentPatch = parentPatchPreset
    if (parentShapeIssue) {
      parentPatch = { ...parentPatchPreset }
      delete parentPatch.model
      delete parentPatch.variant
      assembly.diagnostics.push({ level: "warning", agent: parent, message: `Parent "${parent}": ${parentShapeIssue}; model fields skipped for parent override.` })
    }

    const parentPromptRuntime = parentInfo.system === undefined && hasPromptPatch(parentPatch)
    // Base-only disable: hide the parent from the subagent list (v2 filters
    // hidden agents) while keeping it registered; the before-hook rejects
    // fresh direct calls with the enabled-variant list. A config-hidden
    // parent definition behaves the same automatically - gated on at least
    // one enabled variant so the agent stays reachable and unrelated hidden
    // agents are never touched.
    const disableBase = entry?.disable_base === true && entry?.disable !== true
    const configHiddenBase = !disableBase && entry && entry.disable !== true && parentInfo.hidden === true && enabledVariants.length > 0
    if (disableBase || configHiddenBase) assembly.hiddenBaseParents.add(parent)
    if (Object.keys(parentPatch).length > 0 || disableBase) {
      const tctx = templateContext(parent, undefined, {}, sidecar)
      editor.update(parent, (agent) => {
        applyAgentModel(agent, parentPatch, sidecar)
        if (parentPatch.color !== undefined) agent.color = parentPatch.color
        if (parentPatch.description !== undefined || parentPatch.description_prepend !== undefined || parentPatch.description_append !== undefined) {
          agent.description = applyTextPatch(agent.description ?? parentInfo.description, parentPatch, tctx)
        }
        if (parentInfo.system !== undefined && hasPromptPatch(parentPatch)) {
          agent.system = applyPromptPatch(parentInfo.system, parentPatch, tctx)
        }
        if (disableBase) agent.hidden = true
      })
    }
    assembly.parents.set(parent, { parent, patch: parentPatch, promptRuntime: parentPromptRuntime })

    const parentAliases: string[] = []
    for (const [key, variant] of enabledVariants) {
      const alias = variantName(parent, key, variant)
      const effective = composeVariantPatch(rawParentPatch, undefined, variant, undefined, sidecar)
      const shapeIssue = validateModelShape(effective.model, sidecar)
      if (shapeIssue) {
        assembly.diagnostics.push({ level: "warning", agent: parent, variant: key, alias, message: `Variant "${alias}" skipped: ${shapeIssue}` })
        continue
      }
      if (alias === parent) {
        assembly.diagnostics.push({ level: "error", agent: parent, variant: key, alias, message: `Variant "${alias}" uses the same name as its parent and was skipped.` })
        continue
      }
      const existing = generatedAliases.get(alias)
      if (existing) {
        assembly.diagnostics.push({ level: "error", agent: parent, variant: key, alias, message: `Variant "${alias}" duplicates ${existing} and was skipped.` })
        continue
      }
      if (editor.get(alias) !== undefined) {
        assembly.diagnostics.push({ level: "error", agent: parent, variant: key, alias, message: `Variant "${alias}" conflicts with an existing agent and was skipped.` })
        continue
      }
      generatedAliases.set(alias, `${parent}.${key}`)
      const description = generatedVariantDescription(parent, key, { ...variant, ...effective } as VariantConfig, sidecar)
      const route = registerClone(editor, {
        id: alias,
        alias,
        hidden: false,
        name: alias,
        description,
        parentInfo: editor.get(parent) ?? parentInfo,
        patch: effective,
        rawParentPatch,
        rawVariant: variant,
        sidecar,
        parent,
        key,
      })
      assembly.routes.set(alias, route)
      assembly.aliases.set(alias, route)
      parentAliases.push(alias)
    }
    if (parentAliases.length > 0) {
      // v1 parity: advertise the aliases on the parent description so the
      // model is steered to the exact variant when the user names one.
      const current = editor.get(parent)
      if (current) {
        editor.update(parent, (agent) => {
          agent.description = generatedParentDescription(agent.description ?? parentInfo.description, parent, parentAliases)
        })
      }
    }
  }

  // Hidden per-profile clones. Registered even for manual-only profiles so a
  // manual pin takes effect immediately, without an agent reload.
  for (const [profileName] of Object.entries(sidecar.profiles)) {
    for (const route of assembly.aliases.values()) {
      const profilePatch = profileVariantPatch(sidecar, profileName, route.parent, route.key)
      const profileParent = profileParentPatch(sidecar, profileName, route.parent)
      if (profilePatch === undefined && profileParent === undefined) continue
      const overlaid = composeVariantPatch(route.rawParentPatch, profileParent, route.rawVariant, profilePatch, sidecar)
      const patchedParentInfo = editor.get(route.parent)
      if (!patchedParentInfo) continue
      const parentModel = patchedParentInfo.model ? { ...patchedParentInfo.model } : undefined
      if (sameModelRef(effectiveModelRef(overlaid, sidecar, parentModel), effectiveModelRef(route.patch, sidecar, parentModel))) continue
      const cloneId = variantCloneId(route.alias, profileName)
      if (editor.get(cloneId) !== undefined) {
        assembly.diagnostics.push({ level: "error", agent: route.parent, variant: route.key, alias: route.alias, message: `Profile clone "${cloneId}" conflicts with an existing agent and was skipped.` })
        continue
      }
      const clone = registerClone(editor, {
        id: cloneId,
        alias: route.alias,
        hidden: true,
        name: `${route.alias} (${profileName})`,
        description: route.description,
        parentInfo: patchedParentInfo,
        patch: overlaid,
        rawParentPatch: route.rawParentPatch,
        rawVariant: route.rawVariant,
        sidecar,
        parent: route.parent,
        key: route.key,
        profile: profileName,
      })
      assembly.routes.set(cloneId, clone)
    }
    for (const parentRoute of assembly.parents.values()) {
      const profilePatch = profileParentPatch(sidecar, profileName, parentRoute.parent)
      if (profilePatch === undefined) continue
      const overlaid = applyModelPresetPatch(overlayProfilePatch(parentRoute.patch, profilePatch), sidecar)
      if (validateModelShape(overlaid.model, sidecar)) continue
      const parentInfo = editor.get(parentRoute.parent)
      if (!parentInfo) continue
      const current: V2ModelRef | undefined = parentInfo.model ? { ...parentInfo.model } : undefined
      const ref = effectiveModelRef(overlaid, sidecar, current)
      if (!ref || sameModelRef(ref, current)) continue
      const cloneId = parentCloneId(parentRoute.parent, profileName)
      if (editor.get(cloneId) !== undefined) {
        assembly.diagnostics.push({ level: "error", agent: parentRoute.parent, message: `Profile clone "${cloneId}" conflicts with an existing agent and was skipped.` })
        continue
      }
      editor.update(cloneId, (agent) => {
        agent.mode = "subagent"
        agent.hidden = true
        agent.name = `${parentInfo.name ?? parentRoute.parent} (${profileName})`
        agent.description = parentInfo.description
        agent.model = { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
        if (parentInfo.system !== undefined) agent.system = parentInfo.system
        if (Array.isArray(parentInfo.permissions)) agent.permissions = [...parentInfo.permissions]
        if (parentInfo.steps !== undefined) agent.steps = parentInfo.steps
        copyRequest(agent, parentInfo)
        if (parentInfo.color !== undefined) agent.color = parentInfo.color
      })
      assembly.parentClones.set(cloneId, parentRoute.parent)
    }
  }

  return assembly
}

// ---------------------------------------------------------------------------
// Runtime helpers (pure where possible — exercised by regression tests)
// ---------------------------------------------------------------------------

function unwrapSessionInfo(result: unknown): V2SessionInfo | undefined {
  if (!result || typeof result !== "object") return undefined
  const record = result as { data?: unknown }
  return (record.data ?? result) as V2SessionInfo
}

async function safeSessionGet(context: V2PluginContext, sessionID: string): Promise<V2SessionInfo | undefined> {
  try {
    const timer = new Promise<undefined>((resolve) => {
      const handle = setTimeout(() => resolve(undefined), SESSION_CALL_TIMEOUT_MS)
      ;(handle as unknown as { unref?: () => void }).unref?.()
    })
    return unwrapSessionInfo(await Promise.race([context.session.get({ sessionID }), timer]))
  } catch {
    return undefined
  }
}

function createSessionCaches(context: V2PluginContext) {
  // parentID links are immutable, so the hop cache lives for the plugin;
  // the resolved root model is TTL-cached because primary sessions can
  // switch models mid-conversation.
  const parentCache = new Map<string, string | undefined>()
  const rootCache = new Map<string, { model?: V2ModelRef; at: number }>()
  const remember = (key: string, value: { model?: V2ModelRef; at: number }) => {
    rootCache.set(key, value)
    if (rootCache.size > SESSION_CACHE_MAX) {
      const oldest = rootCache.keys().next().value
      if (oldest !== undefined) rootCache.delete(oldest)
    }
  }
  return {
    /** Resolves the root primary session's model by walking parentID links. */
    async rootModel(sessionID: string): Promise<V2ModelRef | undefined> {
      const cached = rootCache.get(sessionID)
      if (cached && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.model
      let id: string | undefined = sessionID
      for (let depth = 0; depth < ROOT_WALK_MAX_DEPTH && id; depth++) {
        let parentID = parentCache.get(id)
        if (parentID === undefined) {
          const info = await safeSessionGet(context, id)
          if (!info) break
          parentCache.set(id, info.parentID)
          parentID = info.parentID
        }
        if (parentID === undefined) {
          const info = await safeSessionGet(context, id)
          const model = info?.model ? { providerID: info.model.providerID, id: info.model.id, variant: info.model.variant } : undefined
          remember(sessionID, { model, at: Date.now() })
          return model
        }
        id = parentID
      }
      remember(sessionID, { model: undefined, at: Date.now() })
      return undefined
    },
    clear() {
      parentCache.clear()
      rootCache.clear()
    },
  }
}

/** Resolves the agent id that should execute a subagent call (pure). */
export function resolveExecutionAgent(
  input: { agent: string },
  assembly: V2Assembly,
  activeProfile: { name: string } | undefined,
): { agent: string; changed: boolean; alias?: string } | undefined {
  if (assembly.aliases.has(input.agent)) {
    if (activeProfile) {
      const cloneId = variantCloneId(input.agent, activeProfile.name)
      if (assembly.routes.has(cloneId)) return { agent: cloneId, changed: true, alias: input.agent }
    }
    return { agent: input.agent, changed: false, alias: input.agent }
  }
  if (assembly.parents.has(input.agent)) {
    if (activeProfile) {
      const cloneId = parentCloneId(input.agent, activeProfile.name)
      if (assembly.parentClones.has(cloneId)) return { agent: cloneId, changed: true }
    }
    return { agent: input.agent, changed: false }
  }
  return undefined
}

function setSystemText(event: V2SessionContextEvent, text: string) {
  if (event.system.length === 0) event.system.push({ type: "text", text })
  else event.system[0] = { type: "text", text }
}

/** Applies route request/system overrides to a session context event (pure). */
export function applyContextOverrides(
  event: V2SessionContextEvent,
  input: {
    assembly: V2Assembly
    sidecar: SidecarConfig
    activeProfile: { name: string } | undefined
  },
) {
  const { assembly, sidecar, activeProfile } = input
  let agent = event.agent
  const parentOfClone = assembly.parentClones.get(agent)
  if (parentOfClone !== undefined) agent = parentOfClone

  const route = assembly.routes.get(agent)
  if (route) {
    let patch = route.patch
    let profilePrompt = false
    // Visible aliases resolve their profile overlay per call (the active
    // profile depends on this session's root primary model). Hidden clones
    // arrive with their overlay already baked in.
    if (!route.profile && activeProfile) {
      const profilePatch = profileVariantPatch(sidecar, activeProfile.name, route.parent, route.key)
      const profileParent = profileParentPatch(sidecar, activeProfile.name, route.parent)
      if (profilePatch !== undefined || profileParent !== undefined) {
        patch = composeVariantPatch(route.rawParentPatch, profileParent, route.rawVariant, profilePatch, sidecar)
        profilePrompt = (profilePatch !== undefined && hasPromptPatch(profilePatch)) || (profileParent !== undefined && hasPromptPatch(profileParent))
      }
    }
    if (patch.temperature !== undefined) event.generation.temperature = patch.temperature
    if (patch.top_p !== undefined) event.generation.topP = patch.top_p
    if (patch.options !== undefined) Object.assign(event.providerOptions, patch.options)

    const needsSystem = route.promptRuntime || (route.parentSystem !== undefined && profilePrompt)
    if (needsSystem && hasPromptPatch(patch)) {
      const tctx = templateContext(route.parent, route.key, patch, sidecar)
      const current = event.system[0]?.text
      const base = route.parentSystem !== undefined ? route.parentSystem : current
      setSystemText(event, applyPromptPatch(base && base.length > 0 ? base : undefined, patch, tctx))
    }
    return
  }

  // Parent agents: global hot patches apply wherever the parent runs
  // (mirrors v1 chat.params/system.transform agent-keyed lookups). Profile
  // parent overlays only contributed the model, already baked into the
  // hidden parent clone this session was rewritten to — nothing more here.
  const parentRoute = assembly.parents.get(agent)
  if (parentRoute) {
    if (parentRoute.patch.temperature !== undefined) event.generation.temperature = parentRoute.patch.temperature
    if (parentRoute.patch.top_p !== undefined) event.generation.topP = parentRoute.patch.top_p
    if (parentRoute.patch.options !== undefined) Object.assign(event.providerOptions, parentRoute.patch.options)
    if (parentRoute.promptRuntime && hasPromptPatch(parentRoute.patch)) {
      const tctx = templateContext(parentRoute.parent, undefined, {}, sidecar)
      const current = event.system[0]?.text
      setSystemText(event, applyPromptPatch(current && current.length > 0 ? current : undefined, parentRoute.patch, tctx))
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin setup
// ---------------------------------------------------------------------------

export function createV2ServerSetup(): V2ServerSetup {
  return async (context: V2PluginContext) => {
    let assembly: V2Assembly = emptyAssembly()
    const registrations: V2Registration[] = []
    const sessionCaches = createSessionCaches(context)
    let closed = false

    /** Resolves the active profile for a caller session against one sidecar snapshot. */
    const activeProfileFor = async (
      sidecar: SidecarConfig,
      sessionID: string,
    ): Promise<{ name: string; source: "manual" | "auto" } | undefined> => {
      const pin = sidecar.routing.activeProfile
      if (pin) return sidecar.profiles[pin] ? { name: pin, source: "manual" as const } : undefined
      const root = await sessionCaches.rootModel(sessionID)
      if (!root) return undefined
      return resolveActiveProfile(sidecar, { providerID: root.providerID, modelID: root.id, variant: root.variant })
    }

    const agentRegistration = await context.agent.transform((editor) => {
      assembly = assembleV2Agents(editor, safeSidecar())
      logDiagnostics(assembly.diagnostics)
    })

    const beforeRegistration = await context.tool.hook("execute.before", async (event: V2ExecuteBeforeEvent) => {
      if (event.tool !== "subagent") return
      const input = event.input
      if (!input || typeof input !== "object") return
      const args = input as { agent?: unknown; prompt?: unknown; sessionID?: unknown }
      if (typeof args.prompt === "string" && args.prompt.includes("agent-variants-route")) {
        args.prompt = stripLegacyMarkers(args.prompt)
      }
      if (typeof args.agent !== "string" || args.agent === "") return
      const sidecar = safeSidecar()
      // Base-only disable: reject fresh direct calls with the enabled-variant
      // list. v2's failure channel turns a before-hook rejection into the
      // tool's error before it runs. Continuation calls (sessionID resumes)
      // stay allowed by design.
      const continuation = typeof args.sessionID === "string" && args.sessionID ? args.sessionID : undefined
      const directAgent = typeof args.agent === "string" ? args.agent : undefined
      const hiddenBase = directAgent !== undefined && assembly.hiddenBaseParents.has(directAgent) && !assembly.aliases.has(directAgent)
      if (hiddenBase && !continuation && directAgent) {
        const baseEntry = sidecar.agents[directAgent]
        const variants = Object.entries(baseEntry?.variants ?? {})
          .filter(([, variant]) => variant.disable !== true)
          .map(([key, variant]) => variantName(directAgent, key, variant))
        throw new Error(
          variants.length > 0
            ? `Agent "${directAgent}" is disabled - use one of its variants: ${variants.join(", ")}`
            : `Agent "${directAgent}" is disabled and has no enabled variants - re-enable it or a variant in agent-variants`,
        )
      }
      // Resume rule for hidden bases: the base may only resume tasks that ran
      // the base itself. v2 stores the EXECUTING agent on the child session
      // (variant children carry the real alias id), and the subagent tool
      // switches the child's agent on mismatch - so a base resume of a
      // variant child would convert it. Reject unless the session's agent IS
      // the called base. (Bogus session ids are rejected by v2 core before
      // the tool runs; nothing to validate here.)
      if (hiddenBase && continuation && directAgent) {
        const child = await safeSessionGet(context, continuation)
        if (child?.agent !== undefined && child.agent !== directAgent) {
          throw new Error(`Task ${continuation} belongs to agent "${child.agent}" - resume it with that agent instead of the disabled base "${directAgent}".`)
        }
      }
      let profile: { name: string } | undefined
      try {
        profile = await activeProfileFor(sidecar, event.sessionID)
      } catch {
        profile = undefined
      }
      const target = resolveExecutionAgent({ agent: args.agent }, assembly, profile)
      if (!target) return
      if (target.changed) {
        args.agent = target.agent
        debugLog(`AGENT-VARIANTS route: alias=${target.alias ?? args.agent} exec=${target.agent} profile=${profile?.name} (rewrite)`)
      }
    })

    const afterRegistration = await context.tool.hook("execute.after", async (event: V2ExecuteAfterEvent) => {
      if (event.tool !== "subagent" || event.status !== "completed") return
      const input = event.input
      const execAgent = input && typeof input === "object" && typeof (input as { agent?: unknown }).agent === "string" ? (input as { agent: string }).agent : undefined
      if (!execAgent) return
      const route = assembly.routes.get(execAgent)
      if (!route) return
      const metadata = { ...(event.result.metadata ?? {}) }
      metadata.agentVariants = { alias: route.alias, routedAgent: execAgent }
      event.result.metadata = metadata
      if (typeof event.result.content === "string" && event.result.content.includes("agent-variants-route")) {
        event.result.content = stripLegacyMarkers(event.result.content)
      }
    })

    const contextRegistration = await context.session.hook("context", async (event: V2SessionContextEvent) => {
      const agent = event.agent
      if (!assembly.routes.has(agent) && !assembly.parents.has(agent) && !assembly.parentClones.has(agent)) return
      // One sidecar snapshot per event: profile resolution and patch
      // application must not straddle a config swap.
      const sidecar = safeSidecar()
      let activeProfile: { name: string; source: "manual" | "auto" } | undefined
      // Only the dynamic paths (visible aliases and plain parents) depend on
      // the active profile; hidden clones have their overlay baked in.
      if (assembly.aliases.has(agent) || assembly.parents.has(agent)) {
        try {
          activeProfile = await activeProfileFor(sidecar, event.sessionID)
        } catch {
          activeProfile = undefined
        }
      }
      applyContextOverrides(event, { assembly, sidecar, activeProfile })
    })

    registrations.push(agentRegistration, beforeRegistration, afterRegistration, contextRegistration)

    // Sidecar watcher: structural changes go live via a debounced agent
    // reload (the transform re-reads the sidecar on every replay). Watching
    // the parent directory survives the sidecar's atomic temp+rename saves
    // on every platform.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleReload = () => {
      if (closed || reloadTimer !== undefined) return
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        try {
          const result = context.agent.reload()
          if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => undefined)
        } catch {
          // Reload failures keep the previous generation (host semantics).
        }
      }, SIDE_RELOAD_DEBOUNCE_MS)
      ;(reloadTimer as unknown as { unref?: () => void }).unref?.()
    }
    const sidecarPath = defaultSidecarPath()
    const sidecarDir = dirname(sidecarPath)
    const sidecarBase = basename(sidecarPath)
    let watcher: ReturnType<typeof fsWatch> | undefined
    let usingWatchFile = false
    const startWatchFile = () => {
      if (usingWatchFile) return
      usingWatchFile = true
      try {
        fsWatchFile(sidecarPath, { interval: 2000 }, () => scheduleReload())
      } catch {
        // No watcher at all: hot reload still applies on host-triggered replays.
      }
    }
    try {
      watcher = fsWatch(sidecarDir, { persistent: false }, (_kind, filename) => {
        if (!filename || filename === sidecarBase) scheduleReload()
      })
      watcher.on("error", () => {
        try {
          watcher?.close()
        } catch {
          /* already closed */
        }
        watcher = undefined
        startWatchFile()
      })
    } catch {
      watcher = undefined
      startWatchFile()
    }

    return () => {
      closed = true
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
      try {
        watcher?.close()
      } catch {
        /* already closed */
      }
      try {
        unwatchFile(sidecarPath)
      } catch {
        /* not watched */
      }
      sessionCaches.clear()
      for (const registration of registrations) {
        try {
          void registration.dispose()
        } catch {
          /* disposal must not throw */
        }
      }
    }
  }
}
