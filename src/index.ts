import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
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
  fingerprint,
  generatedVariantDescription,
  generatedParentDescription,
  hasPromptPatch,
  hasRequestPatch,
  loadSidecar,
  modelCatalogFromProviders,
  resolveModel,
  splitModelRef,
  templateContext,
  validateModel,
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
}
type PendingRoute = RuntimeRoute & {
  token?: string
  callID: string
  parentSessionID: string
  targetAgent: string
  fingerprint: string
  createdAt: number
}
type ScrubContext = { routes?: Map<string, RuntimeRoute> }
type ScrubResult = { count: number; token?: string; alias?: string; proof?: string }
type ChangedPart = { part: any; before: string; after: string; cleaned: number }

const BUILTIN_AGENTS = new Set(Object.keys(BUILTIN_AGENT_DESCRIPTIONS))
const ROUTE_TTL = 10 * 60 * 1000
const MARKER_PREFIX = "<!-- agent-variants-route"
const MARKER_SUFFIX = " -->"
const ROUTE_MARKER_RE = /<!--\s*agent-variants-route([\s\S]*?)-->/g
const ROUTE_ATTR_RE = /\s+(?:agent_variant|routed_agent|parent_agent|effective_model|model_variant)="[^"]*"/g
const ROUTE_STANDALONE_RE = /\n?\s*<agent_variant\b[^>]*\/?>\s*\n?/g
const ROUTE_ARG_FRAGMENT_RE = /\s*(?:selected_alias|agent_variant|routed_agent|parent_agent|effective_model|model_variant)=(?:"[^"]*"|\\"[^\\]*\\")/g
const PLUGIN_ARG_KEYS = ["selected_alias", "agent_variant", "routed_agent", "parent_agent", "effective_model", "model_variant"] as const
const LIVE_REPAIR_DELAYS = [0, 50, 250, 1000]

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

function removeInvalidModelFields(patch: AgentPatch, config: SidecarConfig, catalog: ModelCatalog) {
  const result = { ...patch }
  if (validateModel(result.model, config, catalog)) {
    delete result.model
    delete result.variant
    return result
  }
  if (validateModelVariant(result.model, result.variant, config, catalog)) delete result.variant
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

function assembleAgents(cfg: Record<string, any>, sidecar: SidecarConfig) {
  cfg.agent = cfg.agent ?? {}
  const virtualRoutes = new Map<string, RuntimeRoute>()
  const parentPromptPatches = new Map<string, AgentPatch>()
  const parentRequestPatches = new Map<string, AgentPatch>()
  const diagnostics: Diagnostic[] = []
  const catalog = modelCatalogFromProviders(cfg.provider)
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

    const parentPatch = removeInvalidModelFields(applyModelPresetPatch(entry.parent, sidecar), sidecar, catalog)
    for (const issue of validatePatchModel(`Parent "${parent}"`, applyModelPresetPatch(entry.parent, sidecar), sidecar, catalog)) {
      diagnostics.push({ level: "warning", agent: parent, message: `${issue}; model fields skipped for parent override.` })
    }
    cfg.agent[parent] = applyConfigPatch({ ...(parentConfig ?? {}) }, parentPatch, sidecar, base, isBuiltin, templateContext(parent, undefined, {}, sidecar))
    if (isBuiltin && hasPromptPatch(parentPatch)) parentPromptPatches.set(parent, parentPatch)
    if (isBuiltin && hasRequestPatch(parentPatch)) parentRequestPatches.set(parent, parentPatch)

    const parentAliases: string[] = []
    for (const [key, variant] of enabledVariants) {
      const alias = variantName(parent, key, variant)
      const effective = applyModelPresetPatch(effectiveVariantPatch(entry.parent, variant), sidecar)
      const modelIssues = validatePatchModel(`Variant "${alias}"`, effective, sidecar, catalog)
      if (modelIssues.length > 0) {
        diagnostics.push({ level: "warning", agent: parent, variant: key, alias, message: `Variant "${alias}" disabled at runtime: ${modelIssues.join(" ")}` })
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

function textFromParts(parts: any[]) {
  const primary = parts.filter((part) => part?.type === "text" && !part.synthetic).map((part) => part.text).join("\n\n")
  if (primary.trim()) return primary
  return parts.filter((part) => part?.type === "text").map((part) => part.text).join("\n\n")
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

function takePending(list: PendingRoute[], input: { parentSessionID?: string; agent?: string; fingerprint: string }) {
  const exact = list.findIndex(
    (item) => item.parentSessionID === input.parentSessionID && item.targetAgent === input.agent && item.fingerprint === input.fingerprint,
  )
  if (exact >= 0) return list.splice(exact, 1)[0]
  const fallbackCandidates = list
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.parentSessionID === input.parentSessionID && item.targetAgent === input.agent)
  if (fallbackCandidates.length === 1) return list.splice(fallbackCandidates[0].index, 1)[0]
}

function getData<T>(value: T | { data?: T } | undefined): T | undefined {
  if (value && typeof value === "object" && "data" in value) return value.data
  return value as T | undefined
}

async function getSession(client: any, sessionID: string) {
  return getData(await client.session.get({ path: { id: sessionID } }).catch(() => undefined)) as { parentID?: string; agent?: string } | undefined
}

async function debugToast(client: any, _enabled: boolean, title: string, message: string) {
  if (!debugEnabled()) return
  try {
    appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${title}: ${message}\n`)
  } catch {
    // Debug logging should never affect routing.
  }
  await client.tui?.showToast?.({
    body: {
      title,
      message,
      variant: "info",
      duration: 12000,
    },
  }).catch(() => undefined)
}

function debugLog(_enabled: boolean, title: string, message: string) {
  if (!debugEnabled()) return
  try {
    appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${title}: ${message}\n`)
  } catch {
    // Debug logging should never affect routing.
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
  const response = await client.session
    ?.message?.({
      path: { id: part.sessionID, messageID: part.messageID },
      query: { directory },
    })
    .catch(() => undefined)
  const message = getData(response) as { parts?: any[] } | undefined
  return message?.parts?.find((item) => item?.id === part.id)
}

async function getStoredMessages(client: any, directory: string, sessionID: string) {
  const response = await client.session
    ?.messages?.({
      path: { id: sessionID },
      query: { directory },
    })
    .catch(() => undefined)
  return getData(response) as Array<{ info?: unknown; parts?: any[] }> | undefined
}

async function findStoredTaskPartByCallID(client: any, directory: string, sessionID: string, callID: string) {
  const messages = await getStoredMessages(client, directory, sessionID)
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

async function findParentTaskPartForChild(client: any, directory: string, parentSessionID: string | undefined, childSessionID: string) {
  if (!parentSessionID) return
  const messages = await getStoredMessages(client, directory, parentSessionID)
  if (!messages) return
  for (const message of [...messages].reverse()) {
    for (const part of [...(message.parts ?? [])].reverse()) {
      if (part?.type === "tool" && part.tool === "task" && taskChildSessionID(part) === childSessionID) return part
    }
  }
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
  for (const entry of parts) {
    const part = entry.part
    debugLog(debugEnabledFlag, `Agent variant ${label} repair diff`, `${part.id}: cleaned=${entry.cleaned}; ${diffSnippet(entry.before, entry.after)}`)
    try {
      const result = await rawClient.patch({
        url: "/session/{sessionID}/message/{messageID}/part/{partID}",
        path: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
        query: { directory },
        body: part,
        headers: { "content-type": "application/json" },
      })
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
    } catch (error) {
      failures.push({ id: part.id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { repaired: parts.length - failures.length, failures }
}

async function delay(ms: number) {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function repairLiveTaskPart(input: { client: any; directory: string; sessionID: string; callID: string; route: RuntimeRoute; routes: Map<string, RuntimeRoute>; debug: boolean }) {
  for (const wait of LIVE_REPAIR_DELAYS) {
    await delay(wait)
    const stored = await findStoredTaskPartByCallID(input.client, input.directory, input.sessionID, input.callID)
    if (!stored) {
      debugLog(input.debug, "Agent variant live repair pending", `${input.callID}: stored task part not found after ${wait}ms`)
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
}

async function warningToast(client: any, diagnostic: Diagnostic) {
  if (debugEnabled()) {
    try {
      appendFileSync(debugLogPath(defaultConfigDir()), `${new Date().toISOString()} ${diagnostic.level.toUpperCase()}: ${diagnostic.message}\n`)
    } catch {
      // Diagnostics should never affect startup.
    }
  }
  if (diagnostic.level === "info") return
  await client.tui?.showToast?.({
    body: {
      title: diagnostic.level === "error" ? "Agent variant skipped" : "Agent variant disabled",
      message: diagnostic.message,
      variant: diagnostic.level === "error" ? "error" : "warning",
      duration: 15000,
    },
  }).catch(() => undefined)
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

function liveRoute(staticRoute: RuntimeRoute, catalog: ModelCatalog) {
  const config = loadSidecar(defaultSidecarPath())
  const entry = config.agents[staticRoute.parent]
  const variant = entry?.variants[staticRoute.key]
  if (!entry || entry.disable === true || !variant || variant.disable === true) {
    throw new Error(`Variant "${staticRoute.alias}" is disabled or removed. Restart OpenCode to update the task list.`)
  }
  if (variantName(staticRoute.parent, staticRoute.key, variant) !== staticRoute.alias) {
    throw new Error(`Variant "${staticRoute.alias}" was renamed. Restart OpenCode to update the task list.`)
  }
  const patch = applyModelPresetPatch(effectiveVariantPatch(entry.parent, variant), config)
  const issues = validatePatchModel(`Variant "${staticRoute.alias}"`, patch, config, catalog)
  if (issues.length > 0) throw new Error(`Variant "${staticRoute.alias}" is invalid after hot reload: ${issues.join(" ")}`)
  return {
    ...staticRoute,
    patch,
    model: resolveModel(patch.model, config),
    variant: patch.variant,
  }
}

const plugin: Plugin = async (input) => {
  const sidecar = loadSidecar(defaultSidecarPath())
  let virtualRoutes = new Map<string, RuntimeRoute>()
  let parentPromptPatches = new Map<string, AgentPatch>()
  let parentRequestPatches = new Map<string, AgentPatch>()
  let catalog = modelCatalogFromProviders(undefined)
  const pending: PendingRoute[] = []
  const tokenRoutes = new Map<string, RuntimeRoute>()
  const bySession = new Map<string, RuntimeRoute>()
  const byCall = new Map<string, RuntimeRoute>()
  const repairFailureToasts = new Set<string>()
  const replayOnlySanitized = new Set<string>()

  return {
    config: async (cfg) => {
      catalog = modelCatalogFromProviders((cfg as Record<string, any>).provider)
      const assembled = assembleAgents(cfg as Record<string, any>, sidecar)
      virtualRoutes = assembled.virtualRoutes
      parentPromptPatches = assembled.parentPromptPatches
      parentRequestPatches = assembled.parentRequestPatches
      for (const diagnostic of assembled.diagnostics) await warningToast(input.client, diagnostic)
    },
    "tool.execute.before": async (hookInput, output) => {
      if (hookInput.tool !== "task") return
      const args = output.args as {
        subagent_type?: string
        prompt?: string
        description?: string
      }
      if (!args?.subagent_type || !args.prompt) return
      const staticRoute = virtualRoutes.get(args.subagent_type)
      if (!staticRoute) return
      const route = liveRoute(staticRoute, catalog)
      cleanupPending(pending, tokenRoutes)
      const usePromptMarker = promptMarkersEnabled()
      const token = usePromptMarker ? randomUUID() : undefined
      const originalDescription = args.description
      if (token) tokenRoutes.set(token, route)
      byCall.set(hookInput.callID, route)
      pending.push({
        ...route,
        token,
        callID: hookInput.callID,
        parentSessionID: hookInput.sessionID,
        targetAgent: route.targetAgent,
        fingerprint: fingerprint({
          parentSessionID: hookInput.sessionID,
          agent: route.targetAgent,
          prompt: args.prompt,
          description: originalDescription,
        }),
        createdAt: Date.now(),
      })
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
      if (hookInput.args && typeof hookInput.args === "object") {
        const args = hookInput.args as Record<string, unknown>
        args.subagent_type = route.alias
      }
      const cleanedArgs = scrubTaskInput(hookInput.args, { routes: virtualRoutes }, route.alias)
      output.title = `${output.title} (@${route.alias} variant)`
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
      const session = await getSession(input.client, hookInput.sessionID)
      const parentTaskPart = await findParentTaskPartForChild(input.client, input.directory, session?.parentID, hookInput.sessionID)
      const metadataRoute = takePendingByCallID(pending, parentTaskPart?.callID) ?? takePendingByCallID(pending, parentTaskPart?.id) ?? byCall.get(parentTaskPart?.callID) ?? byCall.get(parentTaskPart?.id)
      if (metadataRoute) {
        const routeToken = (metadataRoute as Partial<PendingRoute>).token
        if (routeToken) tokenRoutes.delete(routeToken)
        bySession.set(hookInput.sessionID, metadataRoute)
        applyMessageModel(output, metadataRoute)
        await debugToast(
          input.client,
          sidecar.debug,
          "Agent variant model applied (metadata)",
          `${routeSummary(metadataRoute)}; session=${hookInput.sessionID}; parent task=${parentTaskPart?.id ?? "unknown"}; call=${parentTaskPart?.callID ?? "unknown"}`,
        )
        return
      }
      if (parentTaskPart) {
        debugLog(sidecar.debug, "Agent variant metadata route miss", `session=${hookInput.sessionID}; parent task=${parentTaskPart.id ?? "unknown"}; call=${parentTaskPart.callID ?? "unknown"}`)
      }
      const fp = fingerprint({
        parentSessionID: session?.parentID ?? "",
        agent: output.message.agent,
        prompt: textFromParts(output.parts as any[]),
      })
      const route = takePending(pending, {
        parentSessionID: session?.parentID,
        agent: output.message.agent,
        fingerprint: fp,
      })
      if (!route) return
      if (route.token) tokenRoutes.delete(route.token)
      bySession.set(hookInput.sessionID, route)
      applyMessageModel(output, route)
      await debugToast(
        input.client,
        sidecar.debug,
        "Agent variant model applied (fallback)",
        `${routeSummary(route)}; session=${hookInput.sessionID}`,
      )
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

export default plugin
