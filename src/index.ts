import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
import { ensureTuiRegistration } from "./selfwire.js"
import {
  applyPromptPatch,
  applyModelPresetPatch,
  applyTextPatch,
  BUILTIN_AGENT_MODES,
  BUILTIN_AGENT_DESCRIPTIONS,
  defaultConfigDir,
  defaultSidecarPath,
  debugLogPath,
  effectiveVariantPatch,
  generatedVariantDescription,
  generatedParentDescription,
  hasPromptPatch,
  hasRequestPatch,
  loadSidecar,
  modelCatalogFromProviders,
  overlayProfilePatch,
  resolveActiveProfile,
  resolveModel,
  splitModelRef,
  templateContext,
  validateModel,
  validateModelShape,
  validateModelVariant,
  type AgentPatch,
  type Diagnostic,
  type ModelCatalog,
  type SidecarConfig,
  type TemplateContext,
  type VariantConfig,
  variantName,
} from "./config.js"

type AgentConfig = Record<string, any>
type RuntimeRoute = {
  alias: string
  parent: string
  targetAgent: string
  key: string
  patch: AgentPatch
  model?: string
  variant?: string
  base?: AgentPatch
  /** Name of the profile whose overlay shaped this route, if any. */
  profile?: string
  /** Count of child messages this route's model override was applied to. */
  appliedCount?: number
  /** Child sessions bound to this route for the lifetime of its task call.
   * Cleared in tool.execute.after so post-call manual/automated messages to a
   * subagent session are never overridden by a stale route. */
  boundSessions?: string[]
}
type PendingRoute = RuntimeRoute & {
  token?: string
  callID: string
  parentSessionID: string
  targetAgent: string
  createdAt: number
}
type ScrubContext = { routes?: Map<string, RuntimeRoute> }
type ScrubResult = { count: number; token?: string; alias?: string; proof?: string }
type ChangedPart = { part: any; before: string; after: string; cleaned: number }

const BUILTIN_AGENTS = new Set(Object.keys(BUILTIN_AGENT_DESCRIPTIONS))
const ROUTE_TTL = 10 * 60 * 1000
const ROUTE_LOOKUP_DELAYS = [0, 50, 200]
const ROUTE_LOOKUP_TIMEOUT = 500
const MARKER_PREFIX = "<!-- agent-variants-route"
const MARKER_SUFFIX = " -->"
const ROUTE_MARKER_RE = /<!--\s*agent-variants-route([\s\S]*?)-->/g
const ROUTE_ATTR_RE = /\s+(?:agent_variant|routed_agent|parent_agent|effective_model|model_variant)="[^"]*"/g
const ROUTE_STANDALONE_RE = /\n?\s*<agent_variant\b[^>]*\/?>\s*\n?/g
const ROUTE_ARG_FRAGMENT_RE = /\s*(?:selected_alias|agent_variant|routed_agent|parent_agent|effective_model|model_variant)=(?:"[^"]*"|\\"[^\\]*\\")/g
const PLUGIN_ARG_KEYS = ["selected_alias", "agent_variant", "routed_agent", "parent_agent", "effective_model", "model_variant"] as const
const LIVE_REPAIR_DELAYS = [0, 100, 400, 1500, 3000, 4000]
const TOAST_TIMEOUT = 1500
const CATALOG_FETCH_TIMEOUT = 3000
const CLIENT_CALL_TIMEOUT = 3000
const DIAGNOSTIC_RETRY_DELAYS = [750, 1500, 3000, 6000, 12000]
const CATALOG_RETRY_DELAYS = [250, 750, 1500, 3000, 6000]

function attr(value: string | undefined) {
  return (value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function marker(token: string, route: RuntimeRoute) {
  return `${MARKER_PREFIX} token="${attr(token)}" selected_alias="${attr(route.alias)}" routed_agent="${attr(route.targetAgent)}" parent_agent="${attr(route.parent)}" effective_model="${attr(routeModel(route))}" model_variant="${attr(route.variant ?? "default")}"${MARKER_SUFFIX}`
}

function markerInfo(body: string) {
  const trimmed = body.trim()
  const token = trimmed.startsWith(":") ? trimmed.slice(1).trim().split(/\s+/)[0] : /\btoken="([^"]+)"/.exec(body)?.[1]
  const alias = /\bselected_alias="([^"]+)"/.exec(body)?.[1] ?? /\bagent_variant="([^"]+)"/.exec(body)?.[1]
  return { token, alias }
}

function stripRouteMarkers(text: string) {
  let count = 0
  let token: string | undefined
  let alias: string | undefined
  const stripped = text.replace(ROUTE_MARKER_RE, (_match, body: string) => {
    count++
    const info = markerInfo(body)
    token ??= info.token
    alias ??= info.alias
    return ""
  })
  return { text: stripped.replace(/\n{3,}/g, "\n\n").trim(), count, token, alias }
}

function routeForAlias(alias: string | undefined, routes?: Map<string, RuntimeRoute>) {
  if (!alias) return
  return routes?.get(alias)
}

function validAlias(alias: string | undefined, routes?: Map<string, RuntimeRoute>) {
  return routeForAlias(alias, routes)?.alias
}

function inputMatchesRoute(args: Record<string, unknown>, route: RuntimeRoute) {
  return args.subagent_type === route.alias || args.subagent_type === route.targetAgent || args.subagent_type === route.parent
}

function suffixAlias(description: unknown) {
  if (typeof description !== "string") return
  return /\(@([^()\s]+) variant\)/.exec(description)?.[1]
}

function metadataAlias(metadata: unknown, routes?: Map<string, RuntimeRoute>) {
  if (!metadata || typeof metadata !== "object") return
  const value = (metadata as Record<string, unknown>).agentVariants
  if (!value || typeof value !== "object") return
  const alias = (value as Record<string, unknown>).alias
  return validAlias(typeof alias === "string" ? alias : undefined, routes)
}

function legacyOutputAlias(text: string, routes?: Map<string, RuntimeRoute>) {
  const alias = /\bagent_variant="([^"]+)"/.exec(text)?.[1]
  return validAlias(alias, routes)
}

function scrubTaskOutput(text: string, context: ScrubContext = {}): ScrubResult & { text: string } {
  const legacyAlias = legacyOutputAlias(text, context.routes)
  const markerResult = stripRouteMarkers(text)
  const textWithoutStandalone = markerResult.text.replace(ROUTE_STANDALONE_RE, "\n")
  const textWithoutArgFragments = textWithoutStandalone.replace(ROUTE_ARG_FRAGMENT_RE, "")
  const textWithoutAttrs = textWithoutArgFragments.replace(/^<task\b([^>]*)>/, (match) => match.replace(ROUTE_ATTR_RE, ""))
  const output = textWithoutAttrs.replace(/\n{3,}/g, "\n\n").trim()
  const markerAlias = validAlias(markerResult.alias, context.routes)
  return {
    text: output,
    count: markerResult.count + (output === markerResult.text ? 0 : 1),
    token: markerResult.token,
    alias: markerAlias ?? legacyAlias,
    proof: markerAlias ? "marker" : legacyAlias ? "legacy-output" : undefined,
  }
}

function scrubParts(parts: any[], context: ScrubContext = {}) {
  let count = 0
  let token: string | undefined
  let alias: string | undefined
  let proof: string | undefined
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      const result = stripRouteMarkers(part.text)
      if (result.count > 0) {
        part.text = result.text
        count += result.count
        token ??= result.token
        const markerAlias = validAlias(result.alias, context.routes)
        if (markerAlias) {
          alias ??= markerAlias
          proof ??= "marker"
        }
      }
    }
    if (part?.type === "tool" && part.tool === "task") {
      let partAlias = metadataAlias(part.state?.metadata, context.routes)
      let partProof = partAlias ? "metadata" : undefined
      if (partAlias) {
        alias ??= partAlias
        proof ??= partProof
      }
      const inputResult = scrubTaskInput(part.state?.input, context, partAlias)
      count += inputResult.count
      partAlias ??= inputResult.alias
      partProof ??= inputResult.proof
      if (typeof part.state?.output === "string") {
        const result = scrubTaskOutput(part.state.output, context)
        part.state.output = result.text
        count += result.count
        partAlias ??= result.alias
        partProof ??= result.proof
      }
      if (typeof part.state?.error === "string") {
        const result = scrubTaskOutput(part.state.error, context)
        part.state.error = result.text
        count += result.count
        partAlias ??= result.alias
        partProof ??= result.proof
      }
      if (partAlias) {
        const retry = scrubTaskInput(part.state?.input, context, partAlias)
        count += retry.count
      }
      alias ??= partAlias
      proof ??= partProof
    }
  }
  return { count, token, alias, proof }
}

function scrubTaskInput(input: unknown, context: ScrubContext = {}, provenAlias?: string): ScrubResult {
  if (!input || typeof input !== "object") return { count: 0 }
  const args = input as Record<string, unknown>
  let count = 0
  let proof: string | undefined
  let alias = validAlias(provenAlias, context.routes)
  const legacyAlias = validAlias(typeof args.selected_alias === "string" ? args.selected_alias : typeof args.agent_variant === "string" ? args.agent_variant : undefined, context.routes)
  if (!alias && legacyAlias) {
    alias = legacyAlias
    proof = "legacy-input"
  }
  if (typeof args.prompt === "string") {
    const result = stripRouteMarkers(args.prompt)
    if (result.count > 0) {
      args.prompt = result.text
      count += result.count
      const markerAlias = validAlias(result.alias, context.routes)
      if (!alias && markerAlias) {
        alias = markerAlias
        proof = "marker"
      }
    }
  }
  if (!alias) {
    const route = routeForAlias(suffixAlias(args.description), context.routes)
    if (route && inputMatchesRoute(args, route)) {
      alias = route.alias
      proof = "description-suffix"
    }
  }
  for (const key of PLUGIN_ARG_KEYS) {
    if (key in args) {
      delete args[key]
      count++
    }
  }
  if (alias && args.subagent_type !== alias) {
    args.subagent_type = alias
    count++
  }
  return { count, alias, proof }
}

export const __testInternals = {
  applyMessageModel,
  correlateTaskRoute,
  marker,
  scrubParts,
  scrubTaskInput,
  scrubTaskOutput,
  repairLiveTaskPart,
  persistCleanedParts,
  LIVE_REPAIR_DELAYS,
  createHooks,
}

function routeModel(route: RuntimeRoute) {
  return route.model ?? "inherit"
}

function routeSummary(route: RuntimeRoute) {
  return `${route.alias} selected; native agent=${route.targetAgent}; parent=${route.parent}; effective model=${routeModel(route)}; variant=${route.variant ?? "default"}`
}

function agentMode(config: AgentConfig | undefined, agent: string) {
  return config?.mode ?? BUILTIN_AGENT_MODES[agent] ?? "all"
}

function debugEnabled() {
  try {
    return loadSidecar(defaultSidecarPath()).debug
  } catch {
    return false
  }
}

function promptMarkersEnabled() {
  try {
    return loadSidecar(defaultSidecarPath()).routing.prompt_markers
  } catch {
    return false
  }
}

function mergeOptions(target: Record<string, unknown> | undefined, source: Record<string, unknown> | undefined) {
  return { ...(target ?? {}), ...(source ?? {}) }
}

function applyPatch(target: AgentConfig, patch: AgentPatch, config: SidecarConfig, base?: AgentConfig, context?: TemplateContext) {
  const next = target
  patch = applyModelPresetPatch(patch, config)
  const model = resolveModel(patch.model, config)
  if (model) next.model = model
  if (patch.variant !== undefined) next.variant = patch.variant
  if (patch.temperature !== undefined) next.temperature = patch.temperature
  if (patch.top_p !== undefined) next.top_p = patch.top_p
  if (patch.options !== undefined) next.options = mergeOptions(next.options, patch.options)
  if (patch.color !== undefined) next.color = patch.color
  if (patch.description !== undefined || patch.description_prepend !== undefined || patch.description_append !== undefined) {
    next.description = applyTextPatch(next.description ?? base?.description, patch, context)
  }
  if (patch.prompt !== undefined || patch.prompt_prepend !== undefined || patch.prompt_append !== undefined) {
    next.prompt = applyPromptPatch(next.prompt ?? base?.prompt, patch, context)
  }
  return next
}

function validatePatchModel(label: string, patch: AgentPatch, config: SidecarConfig, catalog: ModelCatalog) {
  return [validateModel(patch.model, config, catalog), validateModelVariant(patch.model, patch.variant, config, catalog)]
    .filter((item): item is string => !!item)
    .map((issue) => `${label}: ${issue}`)
}

function validatePatchModelShape(label: string, patch: AgentPatch, config: SidecarConfig) {
  return [validateModelShape(patch.model, config)]
    .filter((item): item is string => !!item)
    .map((issue) => `${label}: ${issue}`)
}

function removeInvalidModelFields(patch: AgentPatch, config: SidecarConfig) {
  const result = { ...patch }
  if (validateModelShape(result.model, config)) {
    delete result.model
    delete result.variant
  }
  return result
}

function applyConfigPatch(target: AgentConfig, patch: AgentPatch, config: SidecarConfig, base: AgentConfig | undefined, builtin: boolean, context?: TemplateContext) {
  const safePatch = builtin && patch.prompt === undefined ? { ...patch, prompt_prepend: undefined, prompt_append: undefined } : patch
  return applyPatch(target, safePatch, config, base, context)
}

function virtualPatch(alias: string, description: string, patch: VariantConfig, config: SidecarConfig, base?: AgentConfig): AgentConfig {
  patch = applyModelPresetPatch(patch, config) as VariantConfig
  const result: AgentConfig = {
    ...(base?.permission !== undefined ? { permission: base.permission } : {}),
    ...(base?.tools !== undefined ? { tools: base.tools } : {}),
    ...(base?.color !== undefined ? { color: base.color } : {}),
    mode: "subagent",
    description,
  }
  const model = resolveModel(patch.model, config)
  if (model) result.model = model
  if (patch.variant !== undefined) result.variant = patch.variant
  if (patch.temperature !== undefined) result.temperature = patch.temperature
  if (patch.top_p !== undefined) result.top_p = patch.top_p
  if (patch.options !== undefined) result.options = patch.options
  if (patch.color !== undefined) result.color = patch.color
  result.prompt = `Virtual alias generated by agent-variants for ${alias}. Runtime routing should execute the parent agent instead.`
  return result
}

export function __testAssembleAgents(cfg: Record<string, any>, sidecar: SidecarConfig) {
  cfg.agent = cfg.agent ?? {}
  const virtualRoutes = new Map<string, RuntimeRoute>()
  const parentPromptPatches = new Map<string, AgentPatch>()
  const parentRequestPatches = new Map<string, AgentPatch>()
  const diagnostics: Diagnostic[] = []
  const originalAgents = new Set([...Object.keys(cfg.agent), ...Object.keys(BUILTIN_AGENT_DESCRIPTIONS)])
  const generatedAliases = new Map<string, string>()

  for (const [parent, entry] of Object.entries(sidecar.agents)) {
    const parentConfig = cfg.agent[parent] as AgentConfig | undefined
    if (entry.disable) {
      diagnostics.push({ level: "info", agent: parent, message: `Parent "${parent}" is disabled in sidecar config.` })
      continue
    }
    if (parentConfig?.disable === true) {
      diagnostics.push({ level: "info", agent: parent, message: `Parent "${parent}" is disabled in OpenCode config; variants skipped.` })
      continue
    }

    const enabledVariants = Object.entries(entry.variants).filter(([, variant]) => variant.disable !== true)
    if (enabledVariants.length === 0) continue

    const isBuiltin = BUILTIN_AGENTS.has(parent)
    const base = parentConfig ?? (isBuiltin ? { description: BUILTIN_AGENT_DESCRIPTIONS[parent] } : undefined)
    if (agentMode(parentConfig, parent) === "primary") {
      diagnostics.push({ level: "warning", agent: parent, message: `Parent agent "${parent}" is primary-only; variants may not be callable by the task tool unless the wizard filter was intentionally disabled.` })
    }
    if (!base && !isBuiltin) {
      diagnostics.push({ level: "warning", agent: parent, message: `Parent agent "${parent}" was not found; variants skipped.` })
      continue
    }

    const parentPatch = removeInvalidModelFields(applyModelPresetPatch(entry.parent, sidecar), sidecar)
    for (const issue of validatePatchModelShape(`Parent "${parent}"`, applyModelPresetPatch(entry.parent, sidecar), sidecar)) {
      diagnostics.push({ level: "warning", agent: parent, message: `${issue}; model fields skipped for parent override.` })
    }
    cfg.agent[parent] = applyConfigPatch({ ...(parentConfig ?? {}) }, parentPatch, sidecar, base, isBuiltin, templateContext(parent, undefined, {}, sidecar))
    if (isBuiltin && hasPromptPatch(parentPatch)) parentPromptPatches.set(parent, parentPatch)
    if (isBuiltin && hasRequestPatch(parentPatch)) parentRequestPatches.set(parent, parentPatch)

    const parentAliases: string[] = []
    for (const [key, variant] of enabledVariants) {
      const alias = variantName(parent, key, variant)
      const effective = applyModelPresetPatch(effectiveVariantPatch(entry.parent, variant), sidecar)
      const modelIssues = validatePatchModelShape(`Variant "${alias}"`, effective, sidecar)
      if (modelIssues.length > 0) {
        diagnostics.push({ level: "warning", agent: parent, variant: key, alias, message: `Variant "${alias}" skipped: ${modelIssues.join(" ")}` })
        continue
      }
      if (alias === parent) {
        diagnostics.push({ level: "error", agent: parent, variant: key, alias, message: `Variant "${alias}" uses the same name as its parent and was skipped.` })
        continue
      }
      const existing = generatedAliases.get(alias)
      if (existing) {
        diagnostics.push({ level: "error", agent: parent, variant: key, alias, message: `Variant "${alias}" duplicates ${existing} and was skipped.` })
        continue
      }
      if (originalAgents.has(alias)) {
        diagnostics.push({ level: "error", agent: parent, variant: key, alias, message: `Variant "${alias}" conflicts with an existing agent and was skipped.` })
        continue
      }
      generatedAliases.set(alias, `${parent}.${key}`)
      parentAliases.push(alias)
      const description = generatedVariantDescription(parent, key, { ...variant, ...effective }, sidecar)
      if (isBuiltin) {
        cfg.agent[alias] = virtualPatch(alias, description, effective as VariantConfig, sidecar, parentConfig)
        virtualRoutes.set(alias, {
          alias,
          parent,
          targetAgent: parent,
          key,
          patch: effective,
          model: resolveModel(effective.model, sidecar),
          variant: effective.variant,
        })
        continue
      }

      const copy = applyPatch({ ...(parentConfig ?? {}) }, effective, sidecar, parentConfig, templateContext(parent, key, effective, sidecar))
      copy.description = description
      delete copy.disable
      cfg.agent[alias] = copy
      virtualRoutes.set(alias, {
        alias,
        parent,
        targetAgent: alias,
        key,
        patch: effective,
        model: resolveModel(effective.model, sidecar),
        variant: effective.variant,
        base: {
          model: parentConfig?.model,
          variant: parentConfig?.variant,
          temperature: parentConfig?.temperature,
          top_p: parentConfig?.top_p,
          prompt: parentConfig?.prompt,
          options: parentConfig?.options,
        },
      })
    }
    if (parentAliases.length > 0) {
      const current = cfg.agent[parent] as AgentConfig | undefined
      cfg.agent[parent] = {
        ...(current ?? {}),
        description: generatedParentDescription(current?.description ?? base?.description, parent, parentAliases),
      }
    }
  }

  return { virtualRoutes, parentPromptPatches, parentRequestPatches, diagnostics }
}

function takeMarkerRoute(parts: any[], routes: Map<string, RuntimeRoute>) {
  const result = scrubParts(parts)
  if (!result.token) return result.count > 0 ? { stripped: result.count } : undefined
  const route = routes.get(result.token)
  routes.delete(result.token)
  return route ? { token: result.token, route, stripped: result.count } : { token: result.token, stripped: result.count }
}

function removePendingToken(list: PendingRoute[], token: string) {
  const index = list.findIndex((item) => item.token === token)
  if (index >= 0) list.splice(index, 1)
}

function takePendingByCallID(list: PendingRoute[], callID: string | undefined) {
  if (!callID) return
  const index = list.findIndex((item) => item.callID === callID)
  if (index >= 0) return list.splice(index, 1)[0]
}

function cleanupPending(list: PendingRoute[], routes?: Map<string, RuntimeRoute>) {
  const cutoff = Date.now() - ROUTE_TTL
  while (list[0] && list[0].createdAt < cutoff) {
    const item = list.shift()
    if (item?.token) routes?.delete(item.token)
  }
}

function bindSessionRoute(routesBySession: Map<string, RuntimeRoute>, childSessionID: string, route: RuntimeRoute) {
  routesBySession.set(childSessionID, route)
  route.boundSessions = [...(route.boundSessions ?? []), childSessionID]
}

function unbindSessionRoutes(routesBySession: Map<string, RuntimeRoute>, route: RuntimeRoute) {
  for (const child of route.boundSessions ?? []) {
    if (routesBySession.get(child) === route) routesBySession.delete(child)
  }
  route.boundSessions = []
}

function correlateTaskRoute(
  list: PendingRoute[],
  routesByCall: Map<string, RuntimeRoute>,
  routesBySession: Map<string, RuntimeRoute>,
  knownRoutes: Map<string, RuntimeRoute>,
  childSessionID: string,
  parentTaskPart: any,
) {
  if (!parentTaskPart) return { route: undefined, proof: undefined }
  // The stored-alias fallback is only authoritative while the call is still
  // in flight (or the status is unknown/legacy): once the part explicitly
  // completed, this message belongs to a manual or automated continuation,
  // and those must respect the session's own model.
  const partRunning = (parentTaskPart.state as { status?: string } | undefined)?.status !== "completed"
  // The stored-alias fallback is only authoritative while the call is still
  // in flight (or the status is unknown/legacy): once the part explicitly
  // completed, this message belongs to a manual or automated continuation,
  // and those must respect the session's own model.
  const aliasRoute = partRunning ? routeForAlias(metadataAlias(parentTaskPart.state?.metadata, knownRoutes), knownRoutes) : undefined
  // Prefer the LIVE call's route over the static registry entry: per-call
  // instances carry the bookkeeping (appliedCount, boundSessions) the
  // after-hook reads. Resuming a prior round's task (task_id) makes the scan
  // find the OLD part for the same child - the static registry would then
  // apply the right model while splitting the counters in two (ghost
  // never-applied warnings).
  const liveAliasRoute = aliasRoute
    ? [...list]
        .filter((item) => item.alias === aliasRoute.alias && item.parent === aliasRoute.parent && typeof item.createdAt === "number")
        .reduce<PendingRoute | undefined>((newest, item) => (!newest || item.createdAt > newest.createdAt ? item : newest), undefined) ??
      [...routesByCall.values()]
        .filter((item) => item.alias === aliasRoute.alias && item.parent === aliasRoute.parent)
        .reduce<RuntimeRoute | undefined>((newest, item) => {
          const created = (item as Partial<PendingRoute>).createdAt
          if (typeof created !== "number") return newest ?? item
          if (!newest) return item
          const newestCreated = (newest as Partial<PendingRoute>).createdAt
          return created > (typeof newestCreated === "number" ? newestCreated : -1) ? item : newest
        }, undefined)
    : undefined
  const metadataRoute = takePendingByCallID(list, parentTaskPart?.callID)
    ?? takePendingByCallID(list, parentTaskPart?.id)
    ?? routesByCall.get(parentTaskPart?.callID)
    ?? routesByCall.get(parentTaskPart?.id)
    ?? liveAliasRoute
    ?? aliasRoute
  if (metadataRoute) {
    bindSessionRoute(routesBySession, childSessionID, metadataRoute)
    return { route: metadataRoute, proof: "metadata" as const }
  }
  routesBySession.delete(childSessionID)
  return { route: undefined, proof: "authoritative-miss" as const }
}

function getData<T>(value: T | { data?: T } | undefined): T | undefined {
  if (value && typeof value === "object" && "data" in value) return value.data
  return value as T | undefined
}

type SessionModel = { providerID: string; modelID: string; variant?: string }

async function getSession(client: any, sessionID: string, timeoutMs = CLIENT_CALL_TIMEOUT) {
  return getData(await safeClientCall(() => client?.session?.get?.({ path: { id: sessionID } }), timeoutMs)) as
    | ({ parentID?: string; agent?: string; model?: { providerID?: string; id?: string; variant?: string } })
    | undefined
}

/** Short-TTL cache of a session's current model (primary-model profile matching). */
const sessionModelCache = new Map<string, { model: SessionModel | undefined; at: number }>()
const SESSION_MODEL_TTL_MS = 10_000

function cachedSessionModel(sessionID: string, model: SessionModel | undefined) {
  sessionModelCache.set(sessionID, { model, at: Date.now() })
  if (sessionModelCache.size > 64) {
    const oldest = sessionModelCache.keys().next().value
    if (oldest !== undefined) sessionModelCache.delete(oldest)
  }
}

async function sessionModel(client: any, sessionID: string): Promise<SessionModel | undefined> {
  const hit = sessionModelCache.get(sessionID)
  if (hit && Date.now() - hit.at < SESSION_MODEL_TTL_MS) return hit.model
  const session = await getSession(client, sessionID)
  const raw = session?.model
  const model = raw && typeof raw.providerID === "string" && typeof raw.id === "string"
    ? { providerID: raw.providerID, modelID: raw.id, ...(raw.variant && raw.variant !== "default" ? { variant: raw.variant } : {}) }
    : undefined
  cachedSessionModel(sessionID, model)
  return model
}

async function debugToast(client: any, _enabled: boolean, title: string, message: string) {
  if (!debugEnabled()) return
  try {
    appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${title}: ${message}\n`)
  } catch {
    // Debug logging should never affect routing.
  }
  if (typeof client?.tui?.showToast !== "function") return
  await timeout(
    Promise.resolve()
      .then(() =>
        client.tui.showToast({
          body: {
            title,
            message,
            variant: "info",
            duration: 12000,
          },
        }),
      )
      .catch(() => undefined),
    TOAST_TIMEOUT,
  )
}

function debugLog(_enabled: boolean, title: string, message: string) {
  if (!debugEnabled()) return
  try {
    appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${title}: ${message}\n`)
  } catch {
    // Debug logging should never affect routing.
  }
}

/** Anomaly-class logging that persists even with debug mode off: any warning
 * that reaches the user as a toast (or should have) also lands in the debug
 * log so post-hoc forensics never depend on the debug switch. */
function alwaysLog(title: string, message: string) {
  try {
    appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} [always] ${title}: ${message}\n`)
  } catch {
    // Logging should never affect routing.
  }
}

function serial(value: unknown) {
  return JSON.stringify(value)
}

function debugSnippet(value: unknown, max = 700) {
  const text = typeof value === "string" ? value : serial(value)
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function commonPrefixLength(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index++
  return index
}

function commonSuffixLength(a: string, b: string, start: number) {
  const max = Math.min(a.length, b.length) - start
  let index = 0
  while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index++
  return index
}

function around(text: string, start: number, end: number, context = 160) {
  const from = Math.max(0, start - context)
  const to = Math.min(text.length, end + context)
  return `${from > 0 ? "..." : ""}${text.slice(from, to)}${to < text.length ? "..." : ""}`
}

function diffSnippet(before: string, after: string) {
  if (before === after) return "no textual diff"
  const prefix = commonPrefixLength(before, after)
  const suffix = commonSuffixLength(before, after, prefix)
  const beforeEnd = before.length - suffix
  const afterEnd = after.length - suffix
  return `before=${around(before, prefix, beforeEnd)} | after=${around(after, prefix, afterEnd)}`
}

function debugPartSnapshot(part: any) {
  return debugSnippet({
    id: part?.id,
    messageID: part?.messageID,
    sessionID: part?.sessionID,
    tool: part?.tool,
    status: part?.state?.status,
    input: part?.state?.input,
    title: part?.state?.title,
    metadata: part?.state?.metadata,
    output: typeof part?.state?.output === "string" ? debugSnippet(part.state.output, 500) : part?.state?.output,
    error: typeof part?.state?.error === "string" ? debugSnippet(part.state.error, 500) : part?.state?.error,
  })
}

function formatRepairError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const data = (error as Record<string, any>).data
    if (typeof data?.message === "string") return data.message
    if (typeof (error as Record<string, any>).message === "string") return (error as Record<string, any>).message
    if (typeof (error as Record<string, any>).name === "string") return (error as Record<string, any>).name
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function getStoredPart(client: any, directory: string, part: any) {
  const response = await safeClientCall(() =>
    client?.session?.message?.({
      path: { id: part.sessionID, messageID: part.messageID },
      query: { directory },
    }),
  )
  const message = getData(response) as { parts?: any[] } | undefined
  return message?.parts?.find((item) => item?.id === part.id)
}

async function getStoredMessages(client: any, directory: string, sessionID: string, timeoutMs = CLIENT_CALL_TIMEOUT, limit?: number) {
  const response = await safeClientCall(() =>
    client?.session?.messages?.({
      path: { id: sessionID },
      query: limit !== undefined ? { directory, limit } : { directory },
    }),
    timeoutMs,
  )
  return getData(response) as Array<{ info?: unknown; parts?: any[] }> | undefined
}

/** Tail-window sizes for parent-history lookups. Correlation and repair only
 * ever need the newest messages (the task part is at/near the end), so every
 * fetch is bounded regardless of session size — full-list scans are gone. */
const PARENT_TAIL_WINDOW = 16
const PARENT_TAIL_WINDOW_WIDE = 48

async function findStoredTaskPartByCallID(client: any, directory: string, sessionID: string, callID: string, limit?: number) {
  const messages = await getStoredMessages(client, directory, sessionID, CLIENT_CALL_TIMEOUT, limit)
  if (!messages) return
  for (const message of [...messages].reverse()) {
    for (const part of [...(message.parts ?? [])].reverse()) {
      if (part?.type === "tool" && part.tool === "task" && (part.callID === callID || part.id === callID)) return part
    }
  }
}

function taskChildSessionID(part: any) {
  const metadata = part?.state?.metadata
  if (!metadata || typeof metadata !== "object") return
  const sessionID = (metadata as Record<string, unknown>).sessionId
  return typeof sessionID === "string" ? sessionID : undefined
}

async function findParentTaskPartForChild(client: any, directory: string, parentSessionID: string | undefined, childSessionID: string, timeoutMs = CLIENT_CALL_TIMEOUT, limit?: number) {
  if (!parentSessionID) return
  const messages = await getStoredMessages(client, directory, parentSessionID, timeoutMs, limit)
  if (!messages) return
  for (const message of [...messages].reverse()) {
    for (const part of [...(message.parts ?? [])].reverse()) {
      if (part?.type === "tool" && part.tool === "task" && taskChildSessionID(part) === childSessionID) return part
    }
  }
}

async function findParentTaskContext(client: any, directory: string, childSessionID: string) {
  let session: { parentID?: string; agent?: string; model?: { providerID?: string; id?: string; variant?: string } } | undefined
  let attempt = 0
  for (const wait of ROUTE_LOOKUP_DELAYS) {
    await delay(wait)
    if (!session) {
      session = await getSession(client, childSessionID, ROUTE_LOOKUP_TIMEOUT)
      if (session && !session.parentID) return { parentTaskPart: undefined, parentSessionID: undefined }
    }
    // Early retries scan a small tail window; later retries widen it in case
    // the task part slid further back. Both stay bounded by message count.
    const window = attempt === 0 ? PARENT_TAIL_WINDOW : PARENT_TAIL_WINDOW_WIDE
    const parentTaskPart = await findParentTaskPartForChild(client, directory, session?.parentID, childSessionID, ROUTE_LOOKUP_TIMEOUT, window)
    if (parentTaskPart) return { parentTaskPart, parentSessionID: session?.parentID }
    attempt++
  }
  return { parentTaskPart: undefined, parentSessionID: undefined }
}

/**
 * Profile base-parent application: when a profile is active and patches this
 * parent agent, and the child is provably a base task call (parent task part
 * exists, its metadata carries no variant alias, and no route correlation
 * matched), apply the profile's parent patch model to the child message.
 * Variant children are excluded by the same correlation proof that gates
 * route application (fail-closed, #751).
 */
async function applyProfileBaseParent(
  client: any,
  agent: string | undefined,
  parentTaskPart: any,
  parentSessionID: string | undefined,
  output: { message: { model?: { providerID: string; modelID: string; variant?: string } } },
): Promise<string | undefined> {
  if (!agent || !parentTaskPart) return undefined
  const metadata = parentTaskPart?.state?.metadata as Record<string, unknown> | undefined
  const variantMeta = metadata?.agentVariants as Record<string, unknown> | undefined
  if (variantMeta && typeof variantMeta.alias === "string") return undefined
  const config = loadSidecar(defaultSidecarPath())
  if (Object.keys(config.profiles).length === 0) return undefined
  const primary = parentSessionID ? await sessionModel(client, parentSessionID) : undefined
  const active = resolveActiveProfile(config, primary)
  if (!active) return undefined
  const entry = config.profiles[active.name]?.agents[agent]
  if (!entry || Object.keys(entry.parent ?? {}).length === 0) return undefined
  const patch = applyModelPresetPatch(overlayProfilePatch({}, entry.parent), config)
  const model = resolveModel(patch.model, config)
  if (!model) return undefined
  const shapeIssue = validateModelShape(patch.model, config)
  if (shapeIssue) return undefined
  const split = splitModelRef(model)
  if (!split) return undefined
  output.message.model = {
    providerID: split.providerID,
    modelID: split.modelID,
    ...(patch.variant ? { variant: patch.variant } : {}),
  }
  return `${active.name} (${active.source})`
}

function partIsClean(part: any, routes: Map<string, RuntimeRoute>) {
  const copy = structuredClone(part)
  const before = serial(copy)
  const result = scrubParts([copy], { routes })
  return { clean: result.count === 0 && before === serial(copy), cleaned: result.count, after: copy }
}

function cleanTaskPartForRoute(part: any, route: RuntimeRoute, routes: Map<string, RuntimeRoute>) {
  const copy = structuredClone(part)
  const before = serial(copy)
  copy.state ??= {}
  copy.state.metadata = {
    ...(copy.state.metadata ?? {}),
    agentVariants: {
      alias: route.alias,
      routedAgent: route.targetAgent,
    },
  }
  const inputResult = scrubTaskInput(copy.state.input, { routes }, route.alias)
  let cleaned = inputResult.count
  if (typeof copy.state.output === "string") {
    const outputResult = scrubTaskOutput(copy.state.output, { routes })
    copy.state.output = outputResult.text
    cleaned += outputResult.count
  }
  if (typeof copy.state.error === "string") {
    const errorResult = scrubTaskOutput(copy.state.error, { routes })
    copy.state.error = errorResult.text
    cleaned += errorResult.count
  }
  const after = serial(copy)
  return { part: copy, before, after, cleaned }
}

function changedMessageParts(messages: any[], routes: Map<string, RuntimeRoute>) {
  const changed: ChangedPart[] = []
  const replayOnly: string[] = []
  let cleaned = 0
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const before = serial(part)
      const result = scrubParts([part], { routes })
      cleaned += result.count
      const after = serial(part)
      if (before === after) continue
      if (typeof part?.id !== "string" || typeof part.messageID !== "string" || typeof part.sessionID !== "string") continue
      if (part?.type !== "tool" || part.tool !== "task") {
        replayOnly.push(part.id)
        continue
      }
      changed.push({ part: structuredClone(part), before, after, cleaned: result.count })
    }
  }
  return { cleaned, changed, replayOnly }
}

async function persistCleanedParts(client: any, directory: string, parts: ChangedPart[], routes: Map<string, RuntimeRoute>, debugEnabledFlag: boolean, label = "history") {
  const failures: Array<{ id: string; message: string }> = []
  const rawClient = client?._client
  if (!rawClient?.patch) {
    return {
      repaired: 0,
      failures: parts.map((entry) => ({ id: entry.part.id, message: "OpenCode SDK raw client is unavailable" })),
    }
  }
  let repaired = 0
  for (const entry of parts) {
    const part = entry.part
    debugLog(debugEnabledFlag, `Agent variant ${label} repair diff`, `${part.id}: cleaned=${entry.cleaned}; ${diffSnippet(entry.before, entry.after)}`)
    try {
      // Re-read the CURRENT stored part before writing. The hook snapshot can
      // be stale relative to OpenCode's own writes (the processor completes
      // the part right after tool.execute.after returns); PATCHing a stale
      // whole-part snapshot can land after that final write and revert the
      // part to running forever. Only completed task parts are repaired -
      // `completed` is terminal in OpenCode's processor, so the fresh read
      // has no further writer to race against.
      const fresh = await getStoredPart(client, directory, part)
      if (!fresh) {
        failures.push({ id: part.id, message: "stored part disappeared before repair" })
        continue
      }
      const freshStatus = (fresh as { state?: { status?: string } }).state?.status
      if (freshStatus !== "completed") {
        debugLog(debugEnabledFlag, `Agent variant ${label} repair skipped`, `${part.id}: stored status=${freshStatus ?? "unknown"}; only completed task parts are repaired`)
        continue
      }
      const freshCopy = structuredClone(fresh)
      const freshScrub = scrubParts([freshCopy], { routes })
      if (freshScrub.count === 0) continue
      const result = await safeClientCall(() =>
        rawClient.patch({
          url: "/session/{sessionID}/message/{messageID}/part/{partID}",
          path: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
          query: { directory },
          body: freshCopy,
          headers: { "content-type": "application/json" },
        }),
      )
      if (!result) {
        failures.push({ id: part.id, message: "part update timed out or failed" })
        continue
      }
      if (result?.error) failures.push({ id: part.id, message: formatRepairError(result.error) })
      else if (result?.response && !result.response.ok) failures.push({ id: part.id, message: `${result.response.status} ${result.response.statusText}` })
      if (failures.some((failure) => failure.id === part.id)) continue
      const stored = await getStoredPart(client, directory, part)
      if (!stored) {
        failures.push({ id: part.id, message: "part update returned success but stored part could not be read back" })
        continue
      }
      const verification = partIsClean(stored, routes)
      debugLog(debugEnabledFlag, `Agent variant ${label} repair verify`, `${part.id}: clean=${verification.clean}; stored=${debugPartSnapshot(stored)}; verificationAfter=${debugPartSnapshot(verification.after)}`)
      if (!verification.clean) failures.push({ id: part.id, message: `persistent repair did not stick; ${verification.cleaned} artifact(s) still detected after read-back` })
      else repaired += 1
    } catch (error) {
      failures.push({ id: part.id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { repaired, failures }
}

async function delay(ms: number) {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function timeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function safeClientCall<T>(call: () => Promise<T> | T, ms = CLIENT_CALL_TIMEOUT): Promise<T | undefined> {
  return timeout(
    Promise.resolve()
      .then(call)
      .catch(() => undefined),
    ms,
  )
}

function diagnosticKey(diagnostic: Diagnostic) {
  return [diagnostic.level, diagnostic.agent ?? "", diagnostic.variant ?? "", diagnostic.alias ?? "", diagnostic.message].join("\0")
}

function toastTitle(diagnostic: Diagnostic) {
  if (diagnostic.level === "error") return "Agent variant error"
  return "Agent variant warning"
}

function toastVariant(diagnostic: Diagnostic) {
  return diagnostic.level === "error" ? "error" : "warning"
}

async function repairLiveTaskPart(input: { client: any; directory: string; sessionID: string; callID: string; route: RuntimeRoute; routes: Map<string, RuntimeRoute>; debug: boolean }) {
  let attempt = 0
  for (const wait of LIVE_REPAIR_DELAYS) {
    await delay(wait)
    const stored = await findStoredTaskPartByCallID(input.client, input.directory, input.sessionID, input.callID, attempt === 0 ? PARENT_TAIL_WINDOW : PARENT_TAIL_WINDOW_WIDE)
    attempt++
    if (!stored) {
      debugLog(input.debug, "Agent variant live repair pending", `${input.callID}: stored task part not found after ${wait}ms`)
      continue
    }
    // NEVER write a snapshot of a non-completed part. OpenCode completes the
    // part shortly after the after-hook returns; a read-modify-write with a
    // pre-completion snapshot can land after that final write and silently
    // revert the part to running forever (parallel variant task calls lost
    // their results this way). `completed` is terminal in OpenCode's
    // processor, so once we see it there is no further writer to race.
    const storedStatus = (stored as { state?: { status?: string } }).state?.status
    if (storedStatus !== "completed") {
      debugLog(input.debug, "Agent variant live repair waiting", `${stored.id}: status=${storedStatus ?? "unknown"} after ${wait}ms; waiting for the task part to complete before repairing`)
      continue
    }
    const cleaned = cleanTaskPartForRoute(stored, input.route, input.routes)
    if (cleaned.before === cleaned.after) {
      debugLog(input.debug, "Agent variant live repair skipped", `${stored.id}: already clean`)
      return
    }
    const repair = await persistCleanedParts(input.client, input.directory, [cleaned], input.routes, input.debug, "live")
    if (repair.repaired === 1) {
      debugLog(input.debug, "Agent variant live repair complete", `${stored.id}: repaired current task part for ${input.route.alias}`)
      return
    }
    debugLog(input.debug, "Agent variant live repair failed", `${stored.id}: ${repair.failures.map((failure) => `${failure.id}: ${failure.message}`).join("; ")}`)
  }
  debugLog(input.debug, "Agent variant live repair gave up", `${input.callID}: part never reached a completed state; leaving stored data untouched`)
}

async function warningToast(client: any, diagnostic: Diagnostic) {
  if (debugEnabled()) {
    try {
      appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${diagnostic.level.toUpperCase()}: ${diagnostic.message}\n`)
    } catch {
      // Diagnostics should never affect startup.
    }
  }
  if (diagnostic.level === "info") return true
  if (typeof client?.tui?.showToast !== "function") return false
  try {
    const delivered = await timeout(
      client.tui.showToast({
        body: {
          title: toastTitle(diagnostic),
          message: diagnostic.message,
          variant: toastVariant(diagnostic),
          duration: 15000,
        },
      }).then(() => true, () => false),
      TOAST_TIMEOUT,
    )
    return delivered === true
  } catch {
    return false
  }
}

function applyRequestPatch(output: { temperature?: number; topP?: number; options: Record<string, any> }, patch: AgentPatch, config: SidecarConfig) {
  patch = applyModelPresetPatch(patch, config)
  if (patch.temperature !== undefined) output.temperature = patch.temperature
  if (patch.top_p !== undefined) output.topP = patch.top_p
  if (patch.options !== undefined) Object.assign(output.options, patch.options)
}

function applySystemPatch(system: string[], patch: AgentPatch, context?: TemplateContext) {
  if (!hasPromptPatch(patch)) return
  const current = system[0] ?? ""
  system[0] = applyPromptPatch(current, patch, context)
}

function cleanTaskOutput(text: string) {
  return scrubTaskOutput(text).text
}

function resetGeneratedRequest(output: { temperature?: number; topP?: number; options: Record<string, any> }, route: RuntimeRoute) {
  if (route.targetAgent === route.parent) return
  if (route.base?.temperature === undefined) delete output.temperature
  if (route.base?.temperature !== undefined) output.temperature = route.base.temperature
  if (route.base?.top_p === undefined) delete output.topP
  if (route.base?.top_p !== undefined) output.topP = route.base.top_p
  output.options = { ...(route.base?.options ?? {}) }
}

function applyMessageModel(output: { message: { model?: { providerID: string; modelID: string; variant?: string } } }, route: RuntimeRoute) {
  route.appliedCount = (route.appliedCount ?? 0) + 1
  const model = splitModelRef(route.model)
  const baseModel = splitModelRef(route.base?.model)
  if (model) {
    output.message.model = {
      providerID: model.providerID,
      modelID: model.modelID,
    }
    if (route.variant) output.message.model.variant = route.variant
    return
  }
  if (route.variant && output.message.model) {
    output.message.model.variant = route.variant
    return
  }
  if (baseModel) {
    output.message.model = {
      providerID: baseModel.providerID,
      modelID: baseModel.modelID,
    }
    if (route.base?.variant) output.message.model.variant = route.base.variant
    return
  }
  if (route.targetAgent !== route.parent) delete output.message.model
}

function responseData(response: unknown) {
  if (response && typeof response === "object" && "data" in response) return (response as { data?: unknown }).data
  return response
}

async function fetchMergedCatalog(client: any) {
  const providerList = responseData(await safeClientCall(() => client?.provider?.list?.(), CATALOG_FETCH_TIMEOUT))
  if (providerList) return modelCatalogFromProviders(providerList)
  const configProviders = responseData(await safeClientCall(() => client?.config?.providers?.(), CATALOG_FETCH_TIMEOUT))
  if (configProviders) return modelCatalogFromProviders(configProviders)
}

function catalogDiagnostics(config: SidecarConfig, catalog: ModelCatalog) {
  const diagnostics: Diagnostic[] = []
  for (const [key, preset] of Object.entries(config.models)) {
    for (const issue of validatePatchModel(`Model preset "${key}"`, preset, config, catalog)) {
      diagnostics.push({ level: "warning", message: issue })
    }
  }
  for (const [parent, entry] of Object.entries(config.agents)) {
    if (entry.disable === true) continue
    for (const issue of validatePatchModel(`Parent "${parent}"`, applyModelPresetPatch(entry.parent, config), config, catalog)) {
      diagnostics.push({ level: "warning", agent: parent, message: `${issue}; model fields may fail until fixed.` })
    }
    for (const [key, variant] of Object.entries(entry.variants)) {
      if (variant.disable === true) continue
      const alias = variantName(parent, key, variant)
      for (const issue of validatePatchModel(`Variant "${alias}"`, applyModelPresetPatch(effectiveVariantPatch(entry.parent, variant), config), config, catalog)) {
        diagnostics.push({ level: "warning", agent: parent, variant: key, alias, message: `Variant "${alias}" is invalid after provider catalog merge: ${issue}. Calls to this variant will fail until fixed.` })
      }
    }
  }
  return diagnostics
}

function liveRoute(staticRoute: RuntimeRoute, catalog: ModelCatalog | undefined, primary?: SessionModel) {
  const config = loadSidecar(defaultSidecarPath())
  const entry = config.agents[staticRoute.parent]
  const variant = entry?.variants[staticRoute.key]
  if (!entry || entry.disable === true || !variant || variant.disable === true) {
    throw new Error(`Variant "${staticRoute.alias}" is disabled or removed. Restart OpenCode to update the task list.`)
  }
  if (variantName(staticRoute.parent, staticRoute.key, variant) !== staticRoute.alias) {
    throw new Error(`Variant "${staticRoute.alias}" was renamed. Restart OpenCode to update the task list.`)
  }
  const active = resolveActiveProfile(config, primary)
  const profileEntry = active ? config.profiles[active.name]?.agents[staticRoute.parent] : undefined
  const profileVariant = profileEntry?.variants[staticRoute.key]
  const parentPatch = applyModelPresetPatch(overlayProfilePatch(entry.parent, profileEntry?.parent), config)
  const variantPatch = applyModelPresetPatch(overlayProfilePatch(variant, profileVariant), config)
  const patch = effectiveVariantPatch(parentPatch, variantPatch)
  const shapeIssues = validatePatchModelShape(`Variant "${staticRoute.alias}"`, patch, config)
  if (shapeIssues.length > 0) throw new Error(`Variant "${staticRoute.alias}" is invalid after hot reload: ${shapeIssues.join(" ")}`)
  if (catalog) {
    const issues = validatePatchModel(`Variant "${staticRoute.alias}"`, patch, config, catalog)
    if (issues.length > 0) throw new Error(`Variant "${staticRoute.alias}" is invalid after provider catalog merge: ${issues.join(" ")}`)
  }
  return {
    ...staticRoute,
    patch,
    model: resolveModel(patch.model, config),
    variant: patch.variant,
    ...(active ? { profile: active.name } : {}),
  }
}

type V1HookSet = Awaited<ReturnType<Plugin>>

/** Builds the v1 hook set. `plugin` loads the real sidecar and runs the
 * self-wire; tests inject their own sidecar through __testInternals. */
async function createHooks(input: Parameters<Plugin>[0], sidecar: SidecarConfig): Promise<V1HookSet> {
  let virtualRoutes = new Map<string, RuntimeRoute>()
  let parentPromptPatches = new Map<string, AgentPatch>()
  let parentRequestPatches = new Map<string, AgentPatch>()
  let catalog: ModelCatalog | undefined
  const pending: PendingRoute[] = []
  const tokenRoutes = new Map<string, RuntimeRoute>()
  const bySession = new Map<string, RuntimeRoute>()
  const byCall = new Map<string, RuntimeRoute>()
  const repairFailureToasts = new Set<string>()
  const replayOnlySanitized = new Set<string>()
  const diagnosticQueue = new Map<string, { diagnostic: Diagnostic; attempts: number }>()
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined
  let diagnosticFlushing = false

  const scheduleDiagnosticFlush = (delayMs = DIAGNOSTIC_RETRY_DELAYS[0]) => {
    if (diagnosticTimer) return
    diagnosticTimer = setTimeout(() => {
      diagnosticTimer = undefined
      void flushDiagnosticQueue()
    }, delayMs)
  }

  const queueDiagnostics = (diagnostics: Diagnostic[]) => {
    for (const diagnostic of diagnostics) {
      if (diagnostic.level === "info") continue
      const key = diagnosticKey(diagnostic)
      // Every user-visible warning/error diagnostic is captured to the debug
      // log unconditionally - the debug flag gates chatter, not evidence.
      alwaysLog(
        "diagnostic queued",
        `${diagnostic.level}: ${diagnostic.message}${diagnostic.agent ? `; agent=${diagnostic.agent}` : ""}${diagnostic.alias ? `; alias=${diagnostic.alias}` : ""}`,
      )
      if (!diagnosticQueue.has(key)) diagnosticQueue.set(key, { diagnostic, attempts: 0 })
    }
    if (diagnosticQueue.size > 0) scheduleDiagnosticFlush()
  }

  const flushDiagnosticQueue = async () => {
    if (diagnosticFlushing) return
    diagnosticFlushing = true
    try {
      for (const [key, item] of Array.from(diagnosticQueue.entries())) {
        const delivered = await warningToast(input.client, item.diagnostic)
        if (delivered) {
          diagnosticQueue.delete(key)
          continue
        }
        item.attempts++
        if (item.attempts >= DIAGNOSTIC_RETRY_DELAYS.length) {
          debugLog(debugEnabled(), "Agent variant diagnostic toast deferred", `failed to deliver after ${item.attempts} attempt(s): ${item.diagnostic.message}`)
          diagnosticQueue.delete(key)
          continue
        }
      }
    } finally {
      diagnosticFlushing = false
    }
    if (diagnosticQueue.size > 0) {
      const nextAttempts = Math.min(...Array.from(diagnosticQueue.values()).map((item) => item.attempts))
      scheduleDiagnosticFlush(DIAGNOSTIC_RETRY_DELAYS[Math.min(nextAttempts, DIAGNOSTIC_RETRY_DELAYS.length - 1)])
    }
  }

  const refreshMergedCatalog = async () => {
    for (const wait of CATALOG_RETRY_DELAYS) {
      await delay(wait)
      const nextCatalog = await fetchMergedCatalog(input.client)
      if (!nextCatalog || nextCatalog.providers.size === 0) {
        debugLog(debugEnabled(), "Agent variant provider catalog pending", `merged catalog unavailable after ${wait}ms`)
        continue
      }
      catalog = nextCatalog
      debugLog(
        debugEnabled(),
        "Agent variant provider catalog ready",
        `${nextCatalog.providers.size} provider(s), ${nextCatalog.refs.size} model reference(s), ${nextCatalog.variants.size} variant set(s)`,
      )
      queueDiagnostics(catalogDiagnostics(loadSidecar(defaultSidecarPath()), nextCatalog))
      return
    }
    debugLog(debugEnabled(), "Agent variant provider catalog unavailable", "deferred model validation could not obtain OpenCode's merged provider catalog")
  }

  return {
    config: async (cfg) => {
      const assembled = __testAssembleAgents(cfg as Record<string, any>, sidecar)
      virtualRoutes = assembled.virtualRoutes
      parentPromptPatches = assembled.parentPromptPatches
      parentRequestPatches = assembled.parentRequestPatches
      queueDiagnostics(assembled.diagnostics)
      void refreshMergedCatalog().catch((error) => {
        debugLog(debugEnabled(), "Agent variant provider catalog error", error instanceof Error ? error.message : String(error))
      })
    },
    "tool.execute.before": async (hookInput, output) => {
      if (hookInput.tool !== "task") return
      const args = output.args as {
        subagent_type?: string
        prompt?: string
        description?: string
        sessionID?: string
        task_id?: string
      }
      if (!args?.subagent_type || !args.prompt) return
      const staticRoute = virtualRoutes.get(args.subagent_type)
      // Continuation calls (input.sessionID) address an existing child: clear
      // any stale route state for it up front. For base (non-variant) calls
      // this prevents a previous round's session-keyed route from leaking
      // onto this call's messages; variant calls re-register below.
      // v1's task tool resumes via `task_id` (a prior task's child session
      // id); the v2 port's subagent tool uses `sessionID`. Both identify the
      // child session up front - accept either.
      const continuationArg = args.task_id ?? args.sessionID
      const continuation = typeof continuationArg === "string" && continuationArg ? continuationArg : undefined
      if (continuation && !staticRoute) bySession.delete(continuation)
      if (!staticRoute) return
      const primary = await sessionModel(input.client, hookInput.sessionID)
      const route = liveRoute(staticRoute, catalog, primary)
      if (!catalog) debugLog(debugEnabled(), "Agent variant validation deferred", `${route.alias}: merged provider catalog is not ready; OpenCode provider validation will be used if needed`)
      cleanupPending(pending, tokenRoutes)
      const usePromptMarker = promptMarkersEnabled()
      const token = usePromptMarker ? randomUUID() : undefined
      if (token) tokenRoutes.set(token, route)
      // One canonical route object per call: byCall, the pending queue, and
      // session bindings all share this instance so per-call bookkeeping
      // (appliedCount) is always read from the object the after-hook holds.
      // Spreading a copy here previously split the counters in two.
      const callRoute = route as RuntimeRoute & Pick<PendingRoute, "token" | "callID" | "parentSessionID" | "createdAt">
      callRoute.token = token
      callRoute.callID = hookInput.callID
      callRoute.parentSessionID = hookInput.sessionID
      callRoute.createdAt = Date.now()
      byCall.set(hookInput.callID, route)
      // Continuation: the child session id is known up front, so the session
      // route is registered immediately - chat.message then correlates with
      // zero parent-history fetches (deterministic regardless of size).
      if (continuation) bindSessionRoute(bySession, continuation, route)
      pending.push(callRoute as PendingRoute)
      if (args.description && !args.description.includes(`@${route.alias} variant`)) {
        args.description = `${args.description} (@${route.alias} variant)`
      }
      if (token) args.prompt = `${args.prompt}\n\n${marker(token, route)}`
      args.subagent_type = route.targetAgent
      await debugToast(
        input.client,
        sidecar.debug,
        "Agent variant routed",
        token ? `${routeSummary(route)}; token=${token.slice(0, 8)}; prompt marker=on` : `${routeSummary(route)}; prompt marker=off`,
      )
    },
    "tool.execute.after": async (hookInput, output) => {
      if (hookInput.tool !== "task") return
      const route = byCall.get(hookInput.callID)
      if (!route) return
      byCall.delete(hookInput.callID)
      if (!route.appliedCount) {
        // The variant was requested and the after-hook annotated the part, but
        // the model override never landed on any child message (correlation
        // miss) - the child silently ran the default model. Surface it instead
        // of letting the annotation claim otherwise. Checked BEFORE the
        // unbind so the bound child list is still intact for the trace.
        const boundBefore = (route.boundSessions ?? []).join(", ")
        const neverApplied = `Variant ${route.alias} was requested but its model override was never applied - the subagent ran the default model (correlation miss; call=${hookInput.callID}). If this repeats, please report it.`
        alwaysLog(
          "Agent variant route never applied",
          `${routeSummary(route)}; call=${hookInput.callID}; bound=[${boundBefore}]; child messages ran the session-default model`,
        )
        queueDiagnostics([
          {
            level: "warning",
            message: neverApplied,
            agent: route.parent,
            alias: route.alias,
          },
        ])
      }
      // The call is over: release the session bindings it established. Later
      // manual or automated messages to this subagent session must run the
      // session's own model, not a stale variant route.
      unbindSessionRoutes(bySession, route)
      if (hookInput.args && typeof hookInput.args === "object") {
        const args = hookInput.args as Record<string, unknown>
        args.subagent_type = route.alias
      }
      const cleanedArgs = scrubTaskInput(hookInput.args, { routes: virtualRoutes }, route.alias)
      const variantSuffix = ` (@${route.alias} variant)`
      if (typeof output.title === "string" && !output.title.endsWith(variantSuffix)) {
        output.title = `${output.title}${variantSuffix}`
      }
      output.metadata = {
        ...output.metadata,
        agentVariants: {
          alias: route.alias,
          routedAgent: route.targetAgent,
        },
      }
      output.output = cleanTaskOutput(output.output)
      void repairLiveTaskPart({
        client: input.client,
        directory: input.directory,
        sessionID: hookInput.sessionID,
        callID: hookInput.callID,
        route,
        routes: new Map(virtualRoutes),
        debug: sidecar.debug,
      }).catch((error) => debugLog(sidecar.debug, "Agent variant live repair error", `${hookInput.callID}: ${error instanceof Error ? error.message : String(error)}`))
      await debugToast(input.client, sidecar.debug, "Agent variant result annotated", `${routeSummary(route)}; cleaned task input fields=${cleanedArgs.count}`)
    },
    "chat.message": async (hookInput, output) => {
      const markerRoute = takeMarkerRoute(output.parts as any[], tokenRoutes)
      if (markerRoute?.route) {
        removePendingToken(pending, markerRoute.token)
        bySession.set(hookInput.sessionID, markerRoute.route)
        applyMessageModel(output, markerRoute.route)
        await debugToast(
          input.client,
          sidecar.debug,
          "Agent variant model applied",
          `${routeSummary(markerRoute.route)}; session=${hookInput.sessionID}; token=${markerRoute.token.slice(0, 8)}`,
        )
        return
      }
      if (markerRoute?.stripped) {
        await debugToast(input.client, sidecar.debug, "Agent variant marker stripped", `stripped ${markerRoute.stripped} route marker(s) without token match; session=${hookInput.sessionID}`)
      }
      // Session-keyed fast path: continuation calls pre-register the route at
      // tool.execute.before (the child id is in the call args), and successful
      // correlations cache it for the session's later messages. Zero
      // parent-history fetches.
      const sessionRoute = bySession.get(hookInput.sessionID)
      if (sessionRoute) {
        applyMessageModel(output, sessionRoute)
        await debugToast(
          input.client,
          sidecar.debug,
          "Agent variant model applied (session)",
          `${routeSummary(sessionRoute)}; session=${hookInput.sessionID}`,
        )
        return
      }
      const { parentTaskPart, parentSessionID } = await findParentTaskContext(input.client, input.directory, hookInput.sessionID)
      const correlation = correlateTaskRoute(
        pending,
        byCall,
        bySession,
        virtualRoutes,
        hookInput.sessionID,
        parentTaskPart,
      )
      if (correlation.route) {
        const routeToken = (correlation.route as Partial<PendingRoute>).token
        if (routeToken) tokenRoutes.delete(routeToken)
        applyMessageModel(output, correlation.route)
        await debugToast(
          input.client,
          sidecar.debug,
          "Agent variant model applied (metadata)",
          `${routeSummary(correlation.route)}; session=${hookInput.sessionID}; parent task=${parentTaskPart?.id ?? "unknown"}; call=${parentTaskPart?.callID ?? "unknown"}`,
        )
        return
      }
      if (parentTaskPart) {
        debugLog(sidecar.debug, "Agent variant metadata route miss", `session=${hookInput.sessionID}; parent task=${parentTaskPart.id ?? "unknown"}; call=${parentTaskPart.callID ?? "unknown"}`)
      }
      const appliedProfile = await applyProfileBaseParent(input.client, hookInput.agent, parentTaskPart, parentSessionID, output)
      if (appliedProfile) {
        await debugToast(
          input.client,
          sidecar.debug,
          "Agent variant profile base-parent applied",
          `profile=${appliedProfile}; agent=${hookInput.agent}; session=${hookInput.sessionID}`,
        )
      }
    },
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      const { cleaned, changed, replayOnly } = changedMessageParts(output.messages as any[], virtualRoutes)
      if (cleaned === 0) return
      const newReplayOnly = replayOnly.filter((partID) => !replayOnlySanitized.has(partID))
      for (const partID of newReplayOnly) replayOnlySanitized.add(partID)
      if (changed.length === 0) {
        if (newReplayOnly.length > 0) {
          debugLog(
            sidecar.debug,
            "Agent variant replay sanitized",
            `removed ${cleaned} model-visible routing artifact(s) from replay-only non-task part(s): ${newReplayOnly.slice(0, 5).join(", ")}`,
          )
        }
        return
      }
      const repair = await persistCleanedParts(input.client, input.directory, changed, virtualRoutes, sidecar.debug, "history")
      const newFailures = repair.failures.filter((failure) => !repairFailureToasts.has(failure.id))
      for (const failure of newFailures) repairFailureToasts.add(failure.id)
      const failureText = newFailures.length
        ? `; failed repairs: ${newFailures.slice(0, 3).map((failure) => `${failure.id}: ${failure.message}`).join("; ")}`
        : repair.failures.length
          ? `; ${repair.failures.length} repeated repair failure(s) suppressed`
          : ""
      const replayOnlyText = replayOnly.length ? `; replay-only non-task part(s): ${replayOnly.length}` : ""
      const message = `removed ${cleaned} model-visible routing artifact(s), repaired ${repair.repaired}/${changed.length} stored task part(s)${replayOnlyText}${failureText}`
      if (repair.repaired === 0 && repair.failures.length > 0 && newFailures.length === 0) {
        debugLog(sidecar.debug, "Agent variant history sanitized", message)
        return
      }
      await debugToast(
        input.client,
        sidecar.debug,
        "Agent variant history sanitized",
        message,
      )
    },
    "chat.params": async (hookInput, output) => {
      const routed = bySession.get(hookInput.sessionID)
      const parent = parentRequestPatches.get(hookInput.agent)
      if (routed) {
        resetGeneratedRequest(output, routed)
        applyRequestPatch(output, routed.patch, sidecar)
        return
      }
      if (parent) applyRequestPatch(output, parent, sidecar)
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!hookInput.sessionID) return
      const routed = bySession.get(hookInput.sessionID)
      if (routed) {
        if (routed.targetAgent !== routed.parent && routed.base?.prompt !== undefined) {
          output.system[0] = applyPromptPatch(routed.base.prompt, routed.patch, templateContext(routed.parent, routed.key, routed.patch, sidecar))
          return
        }
        applySystemPatch(output.system, routed.patch, templateContext(routed.parent, routed.key, routed.patch, sidecar))
        return
      }
      const session = await getSession(input.client, hookInput.sessionID)
      const parent = session?.agent ? parentPromptPatches.get(session.agent) : undefined
      if (parent && session?.agent) applySystemPatch(output.system, parent, templateContext(session.agent, undefined, {}, sidecar))
    },
  }
}

const plugin: Plugin = async (input) => {
  const sidecar = loadSidecar(defaultSidecarPath())
  // v1-only: mirror the standalone server registration into tui.json at the
  // same config level. Stands down entirely when Config Studio is registered
  // anywhere (it embeds agent-variants and provides the wizard UI). v2 hosts
  // never reach this - their setup auto-discovers ./tui.
  const wire = ensureTuiRegistration({ directory: input.directory, worktree: input.worktree })
  if (wire.status === "wired" || wire.status === "corrected") {
    debugLog(sidecar.debug, "Agent variant self-wire", `${wire.status}: ${wire.spec} -> ${"target" in wire ? wire.target : ""}`)
  } else if (wire.status === "failed") {
    debugLog(sidecar.debug, "Agent variant self-wire failed", wire.error)
  }
  return createHooks(input, sidecar)
}

export default plugin
