import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { parse, stringify } from "comment-json"
import { z } from "zod"

export const BUILTIN_AGENT_DESCRIPTIONS: Record<string, string> = {
  build: "The default agent. Executes tools based on configured permissions.",
  plan: "Plan mode. Disallows all edit tools.",
  general: "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
  explore: "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.",
  scout: "Docs and dependency-source specialist. Use this when you need to inspect external documentation, clone dependency repositories into the managed cache, and research library implementation details without modifying the user's workspace.",
}

export const BUILTIN_AGENT_MODES: Record<string, AgentMode> = {
  build: "primary",
  plan: "primary",
  general: "subagent",
  explore: "subagent",
  scout: "subagent",
}

const Color = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
  z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export const PATCH_FIELDS = [
  "model",
  "variant",
  "temperature",
  "top_p",
  "prompt",
  "prompt_prepend",
  "prompt_append",
  "description",
  "description_prepend",
  "description_append",
  "options",
  "color",
] as const
export const HOT_RELOAD_FIELDS = [
  "model",
  "variant",
  "temperature",
  "top_p",
  "prompt",
  "prompt_prepend",
  "prompt_append",
  "options",
] as const
export const RESTART_FIELDS = PATCH_FIELDS.filter((field) => !HOT_RELOAD_FIELDS.includes(field as HotReloadField))

const FieldFlags = z.record(z.string(), z.boolean())

const Patch = z.object({
  model: z.string().optional(),
  variant: z.string().optional(),
  temperature: z.number().finite().optional(),
  top_p: z.number().finite().optional(),
  prompt: z.string().optional(),
  prompt_prepend: z.string().optional(),
  prompt_append: z.string().optional(),
  description: z.string().optional(),
  description_prepend: z.string().optional(),
  description_append: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  color: Color.optional(),
  disable: z.boolean().optional(),
})

const ParentPatch = Patch.extend({
  propagate: FieldFlags.optional(),
})

const Variant = Patch.extend({
  inherit: FieldFlags.optional(),
  name: z.string().min(1).optional(),
})

const ModelShortcut = z.object({
  model: z.string().min(1),
  label: z.string().min(1).optional(),
  variant: z.string().optional(),
  temperature: z.number().finite().optional(),
  top_p: z.number().finite().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

const UiSettings = z.object({
  width: z.enum(["medium", "large", "xlarge"]).default("large"),
  height: z.enum(["compact", "normal", "tall", "max"]).default("normal"),
  height_percent: z.number().int().min(25).max(100).optional(),
}).default({ width: "large", height: "normal" })

export const SidecarConfig = z.object({
  debug: z.boolean().default(false),
  ui: UiSettings,
  models: z.record(z.string(), ModelShortcut).default({}),
  agents: z.record(
    z.string(),
    z.object({
      disable: z.boolean().optional(),
      parent: ParentPatch.default({}),
      variants: z.record(z.string(), Variant).default({}),
    }),
  ).default({}),
})

const BackupOperation = z.object({
  op: z.enum(["add", "remove", "replace"]),
  path: z.array(z.union([z.string(), z.number()])),
  value: z.unknown().optional(),
})

const PatchBackupEntry = z.object({
  type: z.literal("patch"),
  id: z.string(),
  timestamp: z.string(),
  before_hash: z.string(),
  after_hash: z.string(),
  changed_paths: z.array(z.string()),
  reverse_patch: z.array(BackupOperation),
})

const FullBackupEntry = z.object({
  type: z.literal("full"),
  id: z.string(),
  timestamp: z.string(),
  hash: z.string(),
  label: z.string().optional(),
  config: SidecarConfig,
})

export const BackupJournal = z.object({
  version: z.literal(1).default(1),
  patch_limit: z.number().int().min(1).default(50),
  patches: z.array(PatchBackupEntry).default([]),
  full: z.array(FullBackupEntry).default([]),
})

export type PatchField = (typeof PATCH_FIELDS)[number]
export type HotReloadField = (typeof HOT_RELOAD_FIELDS)[number]
export type AgentPatch = z.infer<typeof Patch>
export type ParentPatch = z.infer<typeof ParentPatch>
export type VariantConfig = z.infer<typeof Variant>
export type ModelShortcut = z.infer<typeof ModelShortcut>
export type UiSettings = z.infer<typeof UiSettings>
export type SidecarConfig = z.infer<typeof SidecarConfig>
export type BackupOperation = z.infer<typeof BackupOperation>
export type PatchBackupEntry = z.infer<typeof PatchBackupEntry>
export type FullBackupEntry = z.infer<typeof FullBackupEntry>
export type BackupJournal = z.infer<typeof BackupJournal>
export type DiagnosticLevel = "error" | "warning" | "info"
export type Diagnostic = {
  level: DiagnosticLevel
  message: string
  agent?: string
  variant?: string
  alias?: string
}
export type ModelCatalog = {
  providers: Set<string>
  providersWithModelList: Set<string>
  refs: Set<string>
  variants: Map<string, Set<string>>
}
export type TemplateContext = {
  parent: string
  alias?: string
  variant_key?: string
  model?: string
  model_label?: string
  routed_agent?: string
}
export type AgentMode = "primary" | "subagent" | "all"

export function isHotReloadField(field: string): field is HotReloadField {
  return HOT_RELOAD_FIELDS.includes(field as HotReloadField)
}

export function isPatchField(field: string): field is PatchField {
  return PATCH_FIELDS.includes(field as PatchField)
}

export function patchValue(patch: Partial<Record<PatchField, unknown>> | undefined, field: PatchField) {
  return patch?.[field]
}

export function patchHasValue(patch: Partial<Record<PatchField, unknown>> | undefined, field: PatchField) {
  return patchValue(patch, field) !== undefined
}

export function propagationEnabled(parent: { propagate?: Partial<Record<PatchField, boolean>> } | undefined, field: PatchField) {
  return parent?.propagate?.[field] === true
}

export function inheritanceEnabled(variant: { inherit?: Partial<Record<PatchField, boolean>> } | undefined, field: PatchField) {
  return variant?.inherit?.[field] !== false
}

export function inheritedPatch(parent: ParentPatch, variant: VariantConfig): AgentPatch {
  return Object.fromEntries(
    PATCH_FIELDS
      .filter((field) => propagationEnabled(parent, field) && inheritanceEnabled(variant, field) && patchHasValue(parent, field))
      .map((field) => [field, parent[field]]),
  ) as AgentPatch
}

export function mergePatches(parent: AgentPatch, variant: VariantConfig): AgentPatch {
  return Object.fromEntries(
    PATCH_FIELDS.flatMap((field) => {
      const value = patchHasValue(variant, field) ? variant[field] : parent[field]
      return value === undefined ? [] : [[field, value]]
    }),
  ) as AgentPatch
}

export function effectiveVariantPatch(parent: ParentPatch, variant: VariantConfig): AgentPatch {
  return mergePatches(inheritedPatch(parent, variant), variant)
}

export function defaultConfigDir() {
  return join(homedir(), ".config", "opencode")
}

export function defaultSidecarPath(configDir = defaultConfigDir()) {
  return join(configDir, "agent-variants.jsonc")
}

export function debugLogPath(configDir = defaultConfigDir()) {
  return join(configDir, "agent-variants.debug.log")
}

export function backupJournalPath(configDir = defaultConfigDir()) {
  return join(configDir, "agent-variants.backup.json")
}

export function emptyConfig(): SidecarConfig {
  return { debug: false, ui: { width: "large", height: "normal" }, models: {}, agents: {} }
}

export function loadSidecar(filePath = defaultSidecarPath()) {
  if (!existsSync(filePath)) return emptyConfig()
  return SidecarConfig.parse(parse(readFileSync(filePath, "utf8")))
}

export function emptyBackupJournal(): BackupJournal {
  return { version: 1, patch_limit: 50, patches: [], full: [] }
}

export function loadBackupJournal(filePath = backupJournalPath()) {
  if (!existsSync(filePath)) return emptyBackupJournal()
  return BackupJournal.parse(JSON.parse(readFileSync(filePath, "utf8")))
}

export function saveBackupJournal(journal: BackupJournal, filePath = backupJournalPath()) {
  const parsed = BackupJournal.parse(journal)
  mkdirSync(dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp`
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`)
  renameSync(temp, filePath)
}

export function hashConfig(config: SidecarConfig) {
  return createHash("sha256").update(stableStringify(SidecarConfig.parse(config))).digest("hex")
}

export function createFullBackup(config: SidecarConfig, input?: { label?: string; filePath?: string }) {
  const journal = loadBackupJournal(input?.filePath)
  journal.full.unshift({
    type: "full",
    id: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    hash: hashConfig(config),
    label: input?.label,
    config: SidecarConfig.parse(config),
  })
  saveBackupJournal(journal, input?.filePath)
  return journal
}

export function deleteFullBackup(id: string, filePath = backupJournalPath()) {
  const journal = loadBackupJournal(filePath)
  journal.full = journal.full.filter((entry) => entry.id !== id)
  saveBackupJournal(journal, filePath)
  return journal
}

export function deleteAllFullBackups(filePath = backupJournalPath()) {
  const journal = loadBackupJournal(filePath)
  journal.full = []
  saveBackupJournal(journal, filePath)
  return journal
}

export function reconstructPatchBackup(index: number, current: SidecarConfig, journal = loadBackupJournal()) {
  let config = SidecarConfig.parse(current)
  for (const [entryIndex, entry] of journal.patches.entries()) {
    const currentHash = hashConfig(config)
    if (currentHash !== entry.after_hash) {
      return { ok: false as const, message: `Hash mismatch at patch ${entryIndex + 1}. Current config is ${currentHash.slice(0, 8)}, expected ${entry.after_hash.slice(0, 8)}.` }
    }
    config = applyBackupOperations(config, entry.reverse_patch)
    const restoredHash = hashConfig(config)
    if (restoredHash !== entry.before_hash) {
      return { ok: false as const, message: `Patch ${entryIndex + 1} restored ${restoredHash.slice(0, 8)}, expected ${entry.before_hash.slice(0, 8)}.` }
    }
    if (entryIndex === index) return { ok: true as const, config, consumed: entryIndex + 1 }
  }
  return { ok: false as const, message: "Patch backup was not found." }
}

export function restorePatchBackup(index: number, config: SidecarConfig, input?: { journal?: BackupJournal; filePath?: string }) {
  const journal = input?.journal ?? loadBackupJournal(input?.filePath)
  const restored = reconstructPatchBackup(index, config, journal)
  if (!restored.ok) return restored
  journal.patches = journal.patches.slice(restored.consumed)
  saveBackupJournal(journal, input?.filePath)
  return restored
}

export function saveSidecar(config: SidecarConfig, filePath = defaultSidecarPath(), options?: { backup?: boolean }) {
  const parsed = SidecarConfig.parse(config)
  const previous = existsSync(filePath) ? loadSidecar(filePath) : undefined
  if (previous && stableStringify(previous) === stableStringify(parsed)) return { changed: false }
  mkdirSync(dirname(filePath), { recursive: true })
  if (previous && options?.backup !== false) writePatchBackup(previous, parsed, backupJournalPath(dirname(filePath)))
  const temp = `${filePath}.tmp`
  writeFileSync(temp, `${stringify(parsed, null, 2)}\n`)
  renameSync(temp, filePath)
  return { changed: true }
}

function writePatchBackup(previous: SidecarConfig, next: SidecarConfig, filePath: string) {
  const reverse = diffReverse(previous, next)
  if (reverse.operations.length === 0) return
  const journal = loadBackupJournal(filePath)
  const now = new Date().toISOString()
  journal.patches.unshift({
    type: "patch",
    id: now,
    timestamp: now,
    before_hash: hashConfig(previous),
    after_hash: hashConfig(next),
    changed_paths: reverse.changed_paths,
    reverse_patch: reverse.operations,
  })
  journal.patches = journal.patches.slice(0, journal.patch_limit)
  saveBackupJournal(journal, filePath)
}

function diffReverse(previous: unknown, next: unknown, path: BackupOperation["path"] = []): { operations: BackupOperation[]; changed_paths: string[] } {
  if (stableStringify(previous) === stableStringify(next)) return { operations: [], changed_paths: [] }
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    return {
      operations: [{ op: previous === undefined ? "remove" : next === undefined ? "add" : "replace", path, value: previous }],
      changed_paths: [formatPath(path)],
    }
  }
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .map((key) => diffReverse(previous[key], next[key], [...path, key]))
    .reduce(
      (acc, item) => ({ operations: [...acc.operations, ...item.operations], changed_paths: [...acc.changed_paths, ...item.changed_paths] }),
      { operations: [] as BackupOperation[], changed_paths: [] as string[] },
    )
}

function applyBackupOperations(config: SidecarConfig, operations: BackupOperation[]) {
  const result = structuredClone(config) as Record<string, unknown>
  for (const operation of operations) applyBackupOperation(result, operation)
  return SidecarConfig.parse(result)
}

function applyBackupOperation(target: Record<string, unknown>, operation: BackupOperation) {
  const parent = operation.path.slice(0, -1).reduce((cursor, segment) => {
    if (!isPlainObject(cursor[segment])) cursor[segment] = {}
    return cursor[segment] as Record<string | number, unknown>
  }, target as Record<string | number, unknown>)
  const key = operation.path.at(-1)
  if (key === undefined) return
  if (operation.op === "remove") {
    delete parent[key]
    return
  }
  parent[key] = operation.value
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function isPlainObject(value: unknown): value is Record<string | number, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function formatPath(path: BackupOperation["path"]) {
  return path.length === 0 ? "<root>" : path.join(".")
}

export function renderTemplate(input: string | undefined, context?: TemplateContext) {
  if (!input || !context) return input
  const values: Record<string, string> = {
    parent: context.parent,
    alias: context.alias ?? "",
    variant_key: context.variant_key ?? "",
    model: context.model ?? "",
    model_label: context.model_label ?? context.model ?? "",
    routed_agent: context.routed_agent ?? context.parent,
  }
  return input.replace(/\{(parent|alias|variant_key|model|model_label|routed_agent)\}/g, (_, key: string) => values[key] ?? "")
}

export function applyTextPatch(
  base: string | undefined,
  patch: Pick<AgentPatch, "description" | "description_prepend" | "description_append">,
  context?: TemplateContext,
) {
  const text = patch.description ?? base ?? ""
  return [patch.description_prepend, text, patch.description_append]
    .map((item) => renderTemplate(item, context))
    .filter((item) => item && item.length > 0)
    .join(" ")
    .trim()
}

export function applyPromptPatch(
  base: string | undefined,
  patch: Pick<AgentPatch, "prompt" | "prompt_prepend" | "prompt_append">,
  context?: TemplateContext,
) {
  const text = patch.prompt ?? base ?? ""
  return [patch.prompt_prepend, text, patch.prompt_append]
    .map((item) => renderTemplate(item, context))
    .filter((item) => item && item.length > 0)
    .join("\n\n")
    .trim()
}

export function resolveModel(input: string | undefined, config: SidecarConfig) {
  if (!input) return
  return config.models[input]?.model ?? input
}

export function applyModelPresetPatch(patch: AgentPatch, config: SidecarConfig): AgentPatch {
  const preset = patch.model ? config.models[patch.model] : undefined
  if (!preset) return patch
  return Object.fromEntries(
    PATCH_FIELDS.flatMap((field) => {
      const value = patchHasValue(patch, field)
        ? patch[field]
        : field === "model"
          ? patch.model
          : preset[field as keyof ModelShortcut]
      return value === undefined ? [] : [[field, value]]
    }),
  ) as AgentPatch
}

export function modelLabel(input: string | undefined, config: SidecarConfig) {
  if (!input) return "the configured model"
  return config.models[input]?.label ?? config.models[input]?.model ?? input
}

export function splitModelRef(model: string | undefined) {
  if (!model) return
  const [providerID, ...modelParts] = model.split("/")
  if (!providerID || modelParts.length === 0) return
  return { providerID, modelID: modelParts.join("/") }
}

export function variantName(parent: string, key: string, variant: Pick<VariantConfig, "name">) {
  return variant.name?.trim() || `${parent}-${key}`
}

export function templateContext(parent: string, key: string | undefined, variant: Pick<VariantConfig, "name" | "model">, config: SidecarConfig) {
  const model = resolveModel(variant.model, config)
  const alias = key ? variantName(parent, key, variant) : parent
  return {
    parent,
    alias,
    variant_key: key,
    model,
    model_label: modelLabel(variant.model, config),
    routed_agent: parent,
  } satisfies TemplateContext
}

export function generatedVariantDescription(parent: string, key: string, variant: VariantConfig, config: SidecarConfig) {
  const context = templateContext(parent, key, variant, config)
  const base = variant.description ?? `Copy of the ${parent} agent using ${modelLabel(variant.model, config)}.`
  return [variant.description_prepend, base, variant.description_append]
    .map((item) => renderTemplate(item, context))
    .filter((item) => item && item.length > 0)
    .join(" ")
    .trim()
}

export function modelCatalogFromProviders(providers: unknown): ModelCatalog {
  const catalog: ModelCatalog = { providers: new Set(), providersWithModelList: new Set(), refs: new Set(), variants: new Map() }
  const list = Array.isArray(providers) ? providers : Object.entries((providers ?? {}) as Record<string, unknown>).map(([id, value]) => ({ id, ...(value as object) }))
  for (const provider of list as Array<Record<string, unknown>>) {
    const providerID = typeof provider.id === "string" ? provider.id : undefined
    if (!providerID) continue
    catalog.providers.add(providerID)
    const models = provider.models as Record<string, { id?: string; variants?: Record<string, unknown> }> | undefined
    if (!models || Object.keys(models).length === 0) continue
    catalog.providersWithModelList.add(providerID)
    for (const [key, value] of Object.entries(models)) {
      const refs = [`${providerID}/${key}`, typeof value.id === "string" ? `${providerID}/${value.id}` : undefined].filter((ref): ref is string => !!ref)
      for (const ref of refs) {
        catalog.refs.add(ref)
        if (value.variants && Object.keys(value.variants).length > 0) catalog.variants.set(ref, new Set(Object.keys(value.variants)))
      }
    }
  }
  return catalog
}

export function validateModel(modelInput: string | undefined, config: SidecarConfig, catalog: ModelCatalog) {
  const model = resolveModel(modelInput, config)
  if (!model) return
  const split = splitModelRef(model)
  if (!split) return `Model "${model}" must use provider/model format.`
  if (!catalog.providers.has(split.providerID)) return `Provider "${split.providerID}" is not configured for model "${model}".`
  if (catalog.providersWithModelList.has(split.providerID) && !catalog.refs.has(model)) return `Model "${model}" was not found in provider "${split.providerID}".`
}

export function validateModelVariant(modelInput: string | undefined, variant: string | undefined, config: SidecarConfig, catalog: ModelCatalog) {
  if (!variant) return
  const model = resolveModel(modelInput, config)
  if (!model) return
  const variants = catalog.variants.get(model)
  if (variants && variants.size > 0 && !variants.has(variant)) return `Variant "${variant}" was not found for model "${model}".`
}

export function isSubagentCapableMode(mode: AgentMode | undefined) {
  return mode !== "primary"
}

function unknownFlagKeys(flags: Record<string, boolean> | undefined) {
  if (!flags) return []
  return Object.keys(flags).filter((key) => !isPatchField(key))
}

function aliasIssue(alias: string) {
  if (alias.trim().length === 0) return "Alias is empty after trimming."
  if (alias !== alias.trim()) return `Alias "${alias}" has leading or trailing whitespace.`
  if (/\s/.test(alias)) return `Alias "${alias}" contains whitespace.`
  if (/[\u0000-\u001f\u007f]/.test(alias)) return `Alias "${alias}" contains control characters.`
}

function validatePatchModel(label: string, patch: AgentPatch, config: SidecarConfig, catalog: ModelCatalog) {
  return [
    validateModel(patch.model, config, catalog),
    validateModelVariant(patch.model, patch.variant, config, catalog),
  ].filter((item): item is string => !!item).map((issue) => `${label}: ${issue}`)
}

export function diagnoseConfig(config: SidecarConfig, input: { agents: string[]; providers: unknown; pluginEntries?: unknown[]; agentModes?: Record<string, AgentMode> }) {
  const diagnostics: Diagnostic[] = []
  const catalog = modelCatalogFromProviders(input.providers)
  const knownAgents = new Set([...Object.keys(BUILTIN_AGENT_DESCRIPTIONS), ...input.agents])
  const generated = new Map<string, { agent: string; variant: string }>()

  if (!input.pluginEntries?.some((entry) => String(Array.isArray(entry) ? entry[0] : entry).includes("agent-variants"))) {
    diagnostics.push({ level: "warning", message: "Agent Variants plugin was not found in loaded plugin entries." })
  }

  diagnostics.push({ level: "info", message: `Debug mode is ${config.debug ? "enabled" : "disabled"}.` })

  for (const [key, preset] of Object.entries(config.models)) {
    for (const issue of validatePatchModel(`Model preset "${key}"`, preset, config, catalog)) {
      diagnostics.push({ level: "warning", message: issue })
    }
  }

  try {
    const journal = loadBackupJournal()
    diagnostics.push({ level: "info", message: `Backup journal has ${journal.patches.length} patch restore point(s) and ${journal.full.length} full backup(s).` })
    if (journal.patches.length > 0) {
      const restored = reconstructPatchBackup(0, config, journal)
      if (!restored.ok) diagnostics.push({ level: "warning", message: `Backup journal hash check failed: ${restored.message}` })
    }
  } catch (err) {
    diagnostics.push({ level: "warning", message: `Backup journal could not be read: ${err instanceof Error ? err.message : String(err)}` })
  }

  for (const [agent, entry] of Object.entries(config.agents)) {
    if (!knownAgents.has(agent)) diagnostics.push({ level: "warning", agent, message: `Parent agent "${agent}" is not a known built-in or configured agent.` })
    if (!isSubagentCapableMode(input.agentModes?.[agent])) diagnostics.push({ level: "warning", agent, message: `Parent agent "${agent}" is primary-only and will not be callable by the task tool.` })
    if (entry.disable) diagnostics.push({ level: "info", agent, message: `Parent "${agent}" is disabled in sidecar config.` })
    for (const key of unknownFlagKeys(entry.parent.propagate)) {
      diagnostics.push({ level: "warning", agent, message: `Parent "${agent}" has unknown propagate key "${key}".` })
    }
    for (const issue of validatePatchModel(`Parent "${agent}"`, applyModelPresetPatch(entry.parent, config), config, catalog)) {
      diagnostics.push({ level: "warning", agent, message: issue })
    }
    for (const [key, variant] of Object.entries(entry.variants)) {
      const alias = variantName(agent, key, variant)
      const issue = aliasIssue(alias)
      if (issue) diagnostics.push({ level: "warning", agent, variant: key, alias, message: issue })
      for (const inheritKey of unknownFlagKeys(variant.inherit)) {
        diagnostics.push({ level: "warning", agent, variant: key, alias, message: `Variant "${alias}" has unknown inherit key "${inheritKey}".` })
      }
      if (!isSubagentCapableMode(input.agentModes?.[agent])) diagnostics.push({ level: "warning", agent, variant: key, alias, message: `Variant "${alias}" inherits a primary-only parent and will not be callable by the task tool.` })
      for (const modelIssue of validatePatchModel(`Variant "${alias}"`, applyModelPresetPatch(effectiveVariantPatch(entry.parent, variant), config), config, catalog)) {
        diagnostics.push({ level: "warning", agent, variant: key, alias, message: `Variant "${alias}" disabled at runtime: ${modelIssue}` })
      }
      if (alias === agent) diagnostics.push({ level: "error", agent, variant: key, alias, message: `Variant "${alias}" uses the same name as its parent.` })
      const existing = generated.get(alias)
      if (existing) diagnostics.push({ level: "error", agent, variant: key, alias, message: `Variant alias "${alias}" duplicates ${existing.agent}.${existing.variant}.` })
      if (!existing) generated.set(alias, { agent, variant: key })
      if (knownAgents.has(alias) && alias !== agent) diagnostics.push({ level: "error", agent, variant: key, alias, message: `Variant alias "${alias}" conflicts with an existing agent.` })
    }
  }
  return diagnostics
}

export function fingerprint(input: { parentSessionID: string; agent: string; prompt: string; description?: string }) {
  return createHash("sha256")
    .update(input.parentSessionID)
    .update("\0")
    .update(input.agent)
    .update("\0")
    .update(input.description ?? "")
    .update("\0")
    .update(input.prompt)
    .digest("hex")
}

export function hasPromptPatch(patch: AgentPatch) {
  return patch.prompt !== undefined || patch.prompt_prepend !== undefined || patch.prompt_append !== undefined
}

export function hasRequestPatch(patch: AgentPatch) {
  return patch.model !== undefined || patch.temperature !== undefined || patch.top_p !== undefined || patch.options !== undefined
}
