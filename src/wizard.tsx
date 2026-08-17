/** @jsxImportSource @opentui/solid */

/**
 * Agent Variants wizard library.
 *
 * Contains every dialog, flow, and screen of the Agent Variants TUI. The thin
 * plugin entry lives in tui.tsx; other hosts (Config Studio) import the flows
 * from here and drive them with their own TuiPluginApi instance.
 *
 * Hosts can pass a WizardHost to mainMenu to intercept Save & exit (Config
 * Studio stages the sidecar into its unified change queue instead of writing
 * immediately). Without a host, behavior is identical to the standalone
 * plugin: Save & exit writes the sidecar with backup.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  BUILTIN_AGENT_DESCRIPTIONS,
  backupJournalPath,
  createFullBackup,
  deleteAllFullBackups,
  deleteFullBackup,
  debugLogPath,
  defaultConfigDir,
  defaultSidecarPath,
  diagnoseConfig,
  effectiveVariantPatch,
  generatedVariantBase,
  generatedVariantDescription,
  inferredSelectionPreset,
  inheritanceEnabled,
  inheritedPatch,
  isHotReloadField,
  isSubagentCapableMode,
  loadBackupJournal,
  loadSidecar,
  patchHasValue,
  propagationEnabled,
  reconstructPatchBackup,
  renderTemplate,
  saveSidecar,
  saveBackupJournal,
  SELECTION_PRESETS,
  templateContext,
  variantName,
  type AgentMode,
  type BackupJournal,
  type ModelShortcut,
  type FullBackupEntry,
  type SidecarConfig,
  type VariantConfig,
  type PatchField,
} from "./config.js"

// Types for sidecar entries.

type AgentEntry = SidecarConfig["agents"][string]
type ModelEntry = SidecarConfig["models"][string]
type FieldListChoice =
  | { action: "select"; value: string }
  | { action: "toggle"; value: string }
  | { action: "inspect"; value: string }
type FieldListOption = {
  title: string
  value: string
  description: string
  restart?: boolean
  channel?: boolean
  channelLabel?: string
  channelEnabled?: boolean
  previewColor?: DisplayColor
  kind?: "field" | "action"
}
type DisplayColor = string | TuiPluginApi["theme"]["current"]["text"]
type WizardSelectOption<Value = unknown> = TuiDialogSelectOption<Value> & {
  color?: DisplayColor
  danger?: boolean
  help?: string
}
type ResolvedModel = {
  providerName: string
  modelName: string
  variants: string[]
}
type BackupListItem =
  | { kind: "patch"; index: number; title: string; description: string; valid: boolean }
  | { kind: "full"; id: string; title: string; description: string; entry: FullBackupEntry }
type BackupListChoice =
  | { action: "select"; item: BackupListItem }
  | { action: "delete"; item: BackupListItem }

export type WizardSettings = {
  subagentCapableOnly: boolean
  hotChanges: boolean
  restartReasons: string[]
}

/** Host integration seam: lets an embedding app intercept Save & exit. */
export type WizardHost = {
  /**
   * Called instead of writing the sidecar when the user presses Save & exit.
   * Return "continue" to keep the wizard open (e.g. staged, not saved yet),
   * or "exit" to end the wizard loop.
   */
  onSave?: (config: SidecarConfig, settings: WizardSettings) => Promise<"exit" | "continue">
}

export function newWizardSettings(subagentCapableOnly = true): WizardSettings {
  return { subagentCapableOnly, hotChanges: false, restartReasons: [] }
}
type DialogSize = "medium" | "large" | "xlarge"
type DialogHeight = "compact" | "normal" | "tall" | "max"
type KeyContext = { event?: { preventDefault?: () => void; stopPropagation?: () => void } }

// Constants.

const BUILTIN_AGENT_KEYS = Object.keys(BUILTIN_AGENT_DESCRIPTIONS)
const UI_SIZE_KV = "agent-variants.ui-width"
const UI_HEIGHT_KV = "agent-variants.ui-height"
const UI_HEIGHT_PERCENT_KV = "agent-variants.ui-height-percent"
const HEIGHT_PERCENT_MIN = 25
const HEIGHT_PERCENT_MAX = 100
const HEIGHT_PRESETS: Array<{ label: DialogHeight; value: number; key: string }> = [
  { label: "compact", value: 32, key: "1" },
  { label: "normal", value: 50, key: "2" },
  { label: "tall", value: 68, key: "3" },
  { label: "max", value: 100, key: "4" },
]
const BUILTIN_AGENT_MODES: Record<string, AgentMode> = {
  build: "primary",
  plan: "primary",
  general: "subagent",
  explore: "subagent",
  scout: "subagent",
}
const THEME_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"] as const
const PRESET_COLORS = [
  ["slate", "#64748B"],
  ["red", "#EF4444"],
  ["orange", "#F97316"],
  ["amber", "#F59E0B"],
  ["yellow", "#EAB308"],
  ["lime", "#84CC16"],
  ["green", "#22C55E"],
  ["emerald", "#10B981"],
  ["teal", "#14B8A6"],
  ["cyan", "#06B6D4"],
  ["sky", "#0EA5E9"],
  ["blue", "#3B82F6"],
  ["indigo", "#6366F1"],
  ["violet", "#8B5CF6"],
  ["purple", "#A855F7"],
  ["fuchsia", "#D946EF"],
  ["pink", "#EC4899"],
  ["rose", "#F43F5E"],
] as const

interface FieldDef {
  key: PatchField
  label: string
  type: "string" | "number" | "json"
}

const EDITABLE_FIELDS: FieldDef[] = [
  { key: "model", label: "Model", type: "string" },
  { key: "variant", label: "Variant", type: "string" },
  { key: "temperature", label: "Temperature", type: "number" },
  { key: "top_p", label: "Top P", type: "number" },
  { key: "prompt", label: "Prompt (replace)", type: "string" },
  { key: "prompt_prepend", label: "Prompt prepend", type: "string" },
  { key: "prompt_append", label: "Prompt append", type: "string" },
  { key: "description", label: "Description (replace)", type: "string" },
  { key: "description_prepend", label: "Description prepend", type: "string" },
  { key: "description_append", label: "Description append", type: "string" },
  { key: "options", label: "Options (JSON)", type: "json" },
  { key: "color", label: "Color", type: "string" },
]
const EDITABLE_FIELD_KEYS = new Set(EDITABLE_FIELDS.map((field) => field.key))
const MODEL_PRESET_FIELDS: Array<{ key: keyof ModelShortcut; label: string; type: "string" | "number" | "json"; required?: boolean }> = [
  { key: "model", label: "Model", type: "string", required: true },
  { key: "label", label: "Label", type: "string" },
  { key: "variant", label: "Variant", type: "string" },
  { key: "temperature", label: "Temperature", type: "number" },
  { key: "top_p", label: "Top P", type: "number" },
  { key: "options", label: "Options (JSON)", type: "json" },
]
const SHIELDED_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  "space",
  "tab",
  "backspace",
  "delete",
  "home",
  "end",
  "left",
  "right",
  "/",
  "?",
  ":",
  ";",
  "'",
  '"',
  ",",
  ".",
  "-",
  "=",
  "[",
  "]",
  "\\",
  "`",
] as const

const FIELD_HELP: Record<
  PatchField,
  {
    purpose: string
    parent: string
    variant: string
    empty: string
  }
> = {
  model: {
    purpose: "Selects the provider/model used for this agent call. Values can be named model shortcuts from this sidecar or full provider/model IDs.",
    parent: "Sets the parent agent's model override. It reaches variants only if this field is propagated and the variant accepts inheritance.",
    variant: "Sets this variant's model override. A local value wins over any propagated parent model.",
    empty: "Removing it makes the agent fall back to an inherited parent model, or otherwise to OpenCode's current/session model.",
  },
  variant: {
    purpose: "Selects a provider-specific model variant, when the provider exposes one. This is separate from the agent variant alias name.",
    parent: "Sets the parent agent's provider model variant. It reaches variants only through propagation/inheritance.",
    variant: "Sets the provider model variant for this generated alias. Local value wins over inherited value.",
    empty: "Removing it clears the provider variant override.",
  },
  temperature: {
    purpose: "Controls sampling randomness. Lower values are more deterministic; higher values are more exploratory when the provider supports it.",
    parent: "Sets the parent temperature override and can share it with variants through propagation.",
    variant: "Sets this variant's temperature override. Local value wins over inherited parent temperature.",
    empty: "Removing it lets inherited/provider/default temperature behavior apply.",
  },
  top_p: {
    purpose: "Controls nucleus sampling. Lower values narrow token choices; provider support varies.",
    parent: "Sets the parent top_p override and can share it with variants through propagation.",
    variant: "Sets this variant's top_p override. Local value wins over inherited parent top_p.",
    empty: "Removing it lets inherited/provider/default top_p behavior apply.",
  },
  prompt: {
    purpose: "Replaces the agent prompt override used by Agent Variants. Use this only when you want a full replacement rather than a small patch.",
    parent: "Sets a parent prompt replacement and can share it with variants through propagation.",
    variant: "Sets this variant's prompt replacement. Local value wins over inherited parent prompt replacement.",
    empty: "Removing it clears the replacement and falls back to prepend/append patches or the native prompt.",
  },
  prompt_prepend: {
    purpose: "Adds text before the effective agent prompt. Useful for small steering instructions without replacing the base prompt.",
    parent: "Prepends text to the parent prompt and can share that prepend with variants through propagation.",
    variant: "Prepends text for this variant. Local value wins over inherited parent prepend.",
    empty: "Removing it clears the prepend patch.",
  },
  prompt_append: {
    purpose: "Adds text after the effective agent prompt. This is usually the safest way to add variant-specific behavior.",
    parent: "Appends text to the parent prompt and can share that append with variants through propagation.",
    variant: "Appends text for this variant. Local value wins over inherited parent append.",
    empty: "Removing it clears the append patch.",
  },
  description: {
    purpose: "Replaces the description shown in OpenCode's task-list metadata. This affects what the model reads when choosing a subagent.",
    parent: "Replaces parent description metadata after restart and can be propagated for generated variant descriptions.",
    variant: "Replaces this variant's task-list description after restart.",
    empty: "Removing it restores generated/default description behavior after restart.",
  },
  description_prepend: {
    purpose: "Adds text before the generated or replaced description shown in the task list.",
    parent: "Prepends parent description metadata after restart and can be propagated to variants.",
    variant: "Prepends this variant's task-list description after restart.",
    empty: "Removing it clears the description prepend after restart.",
  },
  description_append: {
    purpose: "Adds text after the generated or replaced description shown in the task list. Good for short routing guidance.",
    parent: "Appends parent description metadata after restart and can be propagated to variants.",
    variant: "Appends this variant's task-list description after restart.",
    empty: "Removing it clears the description append after restart.",
  },
  options: {
    purpose: "JSON object of provider/model request options merged into the LLM call. Use only provider-supported keys.",
    parent: "Sets parent request options and can share them with variants through propagation.",
    variant: "Sets request options for this variant. Local object wins over inherited parent options.",
    empty: "Removing it clears the options override.",
  },
  color: {
    purpose: "Sets the generated agent color in OpenCode UI metadata where supported.",
    parent: "Sets parent color metadata after restart and can be propagated to variants.",
    variant: "Sets this variant's generated agent color after restart.",
    empty: "Removing it restores OpenCode/default color behavior after restart.",
  },
}

// Helpers.

function agentsFromState(api: TuiPluginApi): string[] {
  const configured = Object.keys(api.state.config.agent ?? {})
  const merged = new Set([...BUILTIN_AGENT_KEYS, ...configured])
  return [...merged].sort()
}

function agentMode(api: TuiPluginApi, agent: string): AgentMode {
  return (api.state.config.agent?.[agent]?.mode as AgentMode | undefined) ?? BUILTIN_AGENT_MODES[agent] ?? "all"
}

function agentModes(api: TuiPluginApi) {
  return Object.fromEntries(agentsFromState(api).map((agent) => [agent, agentMode(api, agent)]))
}

function wizardDialogSize(api: TuiPluginApi): DialogSize {
  const value = api.kv.get<DialogSize>(UI_SIZE_KV, "large")
  if (value === "medium" || value === "large" || value === "xlarge") return value
  return "large"
}

function setWizardDialogSize(api: TuiPluginApi, size: DialogSize) {
  api.kv.set(UI_SIZE_KV, size)
  api.ui.dialog.setSize(size)
}

function nextWizardDialogSize(api: TuiPluginApi): DialogSize {
  const current = wizardDialogSize(api)
  if (current === "medium") return "large"
  if (current === "large") return "xlarge"
  return "medium"
}

function wizardDialogHeight(api: TuiPluginApi): DialogHeight {
  const value = api.kv.get<DialogHeight>(UI_HEIGHT_KV, "normal")
  if (value === "compact" || value === "normal" || value === "tall" || value === "max") return value
  return "normal"
}

function setWizardDialogHeight(api: TuiPluginApi, height: DialogHeight) {
  api.kv.set(UI_HEIGHT_KV, height)
}

function clampHeightPercent(value: number) {
  return Math.max(HEIGHT_PERCENT_MIN, Math.min(HEIGHT_PERCENT_MAX, Math.round(value)))
}

function heightPresetPercent(height: DialogHeight) {
  return HEIGHT_PRESETS.find((preset) => preset.label === height)?.value ?? 50
}

function effectiveUiHeightPercent(ui: SidecarConfig["ui"]) {
  return clampHeightPercent(ui.height_percent ?? heightPresetPercent(ui.height))
}

function wizardDialogHeightPercent(api: TuiPluginApi) {
  const value = api.kv.get<number>(UI_HEIGHT_PERCENT_KV, 50)
  return typeof value === "number" && Number.isFinite(value) ? clampHeightPercent(value) : 50
}

function setWizardDialogHeightPercent(api: TuiPluginApi, value: number) {
  api.kv.set(UI_HEIGHT_PERCENT_KV, clampHeightPercent(value))
}

/** Pushes sidecar ui settings into the host kv (used by both entry points). */
export function applyWizardUiSettings(api: TuiPluginApi, config: SidecarConfig) {
  setWizardDialogSize(api, config.ui.width)
  setWizardDialogHeight(api, config.ui.height)
  setWizardDialogHeightPercent(api, effectiveUiHeightPercent(config.ui))
}

function useWizardDialogSize(api: TuiPluginApi) {
  createEffect(() => api.ui.dialog.setSize(wizardDialogSize(api)))
}

function useHidePromptCursor(api: TuiPluginApi) {
  const editors = collectEditors(api.renderer.root)
  const previous = editors.map((editor) => ({ editor, showCursor: editor.showCursor }))
  for (const editor of editors) {
    editor.showCursor = false
  }
  onCleanup(() => {
    for (const item of previous) {
      if (item.editor.isDestroyed) continue
      item.editor.showCursor = item.showCursor
    }
  })
}

function collectEditors(root: { getChildren?: () => unknown[] }): Array<{ showCursor: boolean; isDestroyed?: boolean; getChildren?: () => unknown[] }> {
  const children = typeof root.getChildren === "function" ? root.getChildren() : []
  return [
    ...(typeof (root as { showCursor?: unknown }).showCursor === "boolean" ? [root as { showCursor: boolean; isDestroyed?: boolean; getChildren?: () => unknown[] }] : []),
    ...children.flatMap((child) => collectEditors(child as { getChildren?: () => unknown[] })),
  ]
}

function shieldBindings(command: string, except: readonly string[] = []) {
  const allowed = new Set(except)
  return SHIELDED_KEYS
    .filter((key) => !allowed.has(key))
    .map((key) => ({ key, cmd: command, desc: "Keep input inside Agent Variants" }))
}

function blockKey(ctx: KeyContext | undefined) {
  ctx?.event?.preventDefault?.()
  ctx?.event?.stopPropagation?.()
}

function cappedHeight(count: number, max: number, min = 1) {
  if (count <= 0) return min
  return Math.max(min, Math.min(count, max))
}

function dialogContentWidth(api: TuiPluginApi) {
  const size = wizardDialogSize(api)
  if (size === "xlarge") return 106
  if (size === "large") return 78
  return 50
}

function estimatedVisualRows(message: string, width: number) {
  return message.split(/\r?\n/).reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / Math.max(1, width))), 0)
}

function wizardMaxRows(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  const usable = Math.max(minRows, terminalHeight - chromeRows)
  return Math.max(minRows, Math.min(usable, Math.floor(terminalHeight * (wizardDialogHeightPercent(api) / 100))))
}

function menuTitleWidth(size: DialogSize, options: readonly { title: string }[]) {
  const longest = Math.max(0, ...options.map((option) => option.title.length)) + 3
  if (size === "xlarge") return Math.min(Math.max(24, longest), 36)
  if (size === "large") return Math.min(Math.max(24, longest), 30)
  return Math.min(Math.max(22, longest), 26)
}

function visibleAgents(api: TuiPluginApi) {
  return agentsFromState(api)
    .map((name) => ({ name, config: api.state.config.agent?.[name] }))
    .filter((agent) => agent.config?.hidden !== true)
    .sort((a, b) => {
      const defaultAgent = api.state.config.default_agent ?? "build"
      if (a.name === defaultAgent) return -1
      if (b.name === defaultAgent) return 1
      return a.name.localeCompare(b.name)
    })
}

function selectableParentAgents(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings) {
  const aliases = generatedAliasSet(config)
  return agentsFromState(api)
    .filter((agent) => !aliases.has(agent))
    .filter((agent) => !settings.subagentCapableOnly || isSubagentCapableMode(agentMode(api, agent)))
}

function modelOptions(api: TuiPluginApi, config: SidecarConfig, input?: { includePresets?: boolean }): TuiDialogSelectOption<string>[] {
  const opts: TuiDialogSelectOption<string>[] = []

  for (const [key, raw] of input?.includePresets === false ? [] : Object.entries(config.models)) {
    const entry = raw as ModelEntry
    opts.push({
      title: `${key} -> ${entry.model}`,
      value: key,
      description: [
        entry.label ?? entry.model,
        entry.variant ? `variant ${entry.variant}` : undefined,
        entry.temperature !== undefined ? `temp ${entry.temperature}` : undefined,
        entry.top_p !== undefined ? `top_p ${entry.top_p}` : undefined,
        entry.options !== undefined ? "options" : undefined,
      ].filter(Boolean).join(" - "),
      category: "Named shortcuts",
    })
  }

  const seen = new Set<string>()
  for (const provider of api.state.provider) {
    for (const model of Object.values(provider.models)) {
      const ref = `${provider.id}/${model.id}`
      if (seen.has(ref)) continue
      seen.add(ref)
      opts.push({
        title: model.name,
        value: ref,
        description: `via ${provider.name}`,
        category: provider.name,
      })
    }
  }

  opts.push({
    title: "Custom model",
    value: "__custom__",
    description: "Type a provider/model ID manually",
    category: "Custom",
  })

  return opts
}

function modelPresetDescription(entry: ModelShortcut | undefined) {
  if (!entry) return "not configured"
  return [
    entry.model,
    entry.variant ? `variant ${entry.variant}` : undefined,
    entry.temperature !== undefined ? `temp ${entry.temperature}` : undefined,
    entry.top_p !== undefined ? `top_p ${entry.top_p}` : undefined,
    entry.options !== undefined ? "options" : undefined,
  ].filter(Boolean).join(" - ")
}

function modelPresetHelp(key: string, entry: ModelShortcut | undefined) {
  return [
    `Model preset: ${key}`,
    "",
    "A model preset is a reusable shortcut for model-related runtime fields.",
    "Use the preset key in any Model field, for example light or heavy.",
    "",
    "When applied, the preset supplies model, model variant, temperature, top_p, and options.",
    "A parent or variant can still override any of those fields locally after selecting the preset.",
    "",
    `Current: ${modelPresetDescription(entry)}`,
  ].join("\n")
}

function resolveModelReference(api: TuiPluginApi, config: SidecarConfig, model: unknown): ResolvedModel | undefined {
  if (typeof model !== "string" || model.length === 0) return undefined
  const modelRef = (config.models[model] as ModelEntry | undefined)?.model ?? model
  const slash = modelRef.indexOf("/")
  if (slash === -1) return undefined
  const providerID = modelRef.slice(0, slash)
  const modelID = modelRef.slice(slash + 1)
  const provider = api.state.provider.find((item) => item.id === providerID)
  const providerModel = provider?.models[modelID]
  if (!provider || !providerModel) return undefined
  return {
    providerName: provider.name,
    modelName: providerModel.name,
    variants: Object.keys(providerModel.variants ?? {}),
  }
}

function modelDisplayName(api: TuiPluginApi, config: SidecarConfig, model: unknown): string | undefined {
  return resolveModelReference(api, config, model)?.modelName
}

function modelVariantOptions(api: TuiPluginApi, config: SidecarConfig, model: unknown): TuiDialogSelectOption<string>[] {
  const resolved = resolveModelReference(api, config, model)
  const opts: WizardSelectOption<string>[] = [
    { title: "Default", value: "__remove__", description: "Remove this local model variant override", category: "Default" },
  ]
  if (resolved) for (const variant of resolved.variants) {
    opts.push({ title: variant, value: variant, description: `${resolved.modelName} via ${resolved.providerName}`, category: "Known variants" })
  }
  opts.push({
    title: "Custom variant",
    value: "__custom__",
    description: resolved ? "Type a provider-specific variant manually" : "No concrete model selected; type a variant manually",
    category: "Custom",
  })
  return opts
}

function colorOptions(api: TuiPluginApi): WizardSelectOption<string>[] {
  const opts: WizardSelectOption<string>[] = THEME_COLORS.map((c) => ({
    title: c,
    value: c,
    category: "Theme colors",
    color: resolveUiColor(api, c),
  }))
  for (const [name, value] of PRESET_COLORS) {
    opts.push({
      title: name,
      value,
      description: value,
      category: "Preset colors",
      color: value,
    })
  }
  opts.push({
    title: "Custom hex",
    value: "__custom__",
    description: "Enter a hex color like #FF5733",
    category: "Custom",
  })
  return opts
}

function resolveUiColor(api: TuiPluginApi, color: unknown): DisplayColor | undefined {
  if (typeof color !== "string" || color.length === 0) return undefined
  if (THEME_COLORS.includes(color as (typeof THEME_COLORS)[number])) return api.theme.current[color as (typeof THEME_COLORS)[number]]
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
  return undefined
}

function parentColor(api: TuiPluginApi, config: SidecarConfig, agent: string): DisplayColor | undefined {
  return resolveUiColor(api, (config.agents[agent] as AgentEntry | undefined)?.parent.color)
    ?? resolveUiColor(api, api.state.config.agent?.[agent]?.color)
    ?? fallbackAgentColor(api, agent)
}

function variantColor(api: TuiPluginApi, config: SidecarConfig, agent: string, key: string, variant: VariantConfig): DisplayColor | undefined {
  return resolveUiColor(api, effectiveVariantPatch((config.agents[agent] as AgentEntry | undefined)?.parent ?? {}, variant).color)
    ?? parentColor(api, config, agent)
}

function fallbackAgentColor(api: TuiPluginApi, agent: string): DisplayColor | undefined {
  const index = visibleAgents(api).findIndex((item) => item.name === agent)
  const palette = [
    api.theme.current.secondary,
    api.theme.current.accent,
    api.theme.current.success,
    api.theme.current.warning,
    api.theme.current.primary,
    api.theme.current.error,
    api.theme.current.info,
  ]
  if (index === -1) return palette[0]
  return palette[index % palette.length]
}

export function variantCount(config: SidecarConfig): number {
  let count = 0
  for (const raw of Object.values(config.agents)) {
    count += Object.keys((raw as AgentEntry).variants).length
  }
  return count
}

function agentEntries(config: SidecarConfig): Array<[string, AgentEntry]> {
  return Object.entries(config.agents) as Array<[string, AgentEntry]>
}

function variantEntries(entry: AgentEntry): Array<[string, VariantConfig]> {
  return Object.entries(entry.variants) as Array<[string, VariantConfig]>
}

function generatedAliasSet(config: SidecarConfig) {
  const aliases = new Set<string>()
  for (const [agent, entry] of agentEntries(config)) {
    for (const [key, variant] of variantEntries(entry)) {
      aliases.add(variantName(agent, key, variant))
    }
  }
  return aliases
}

function fieldDef(key: string) {
  return EDITABLE_FIELDS.find((field) => field.key === key)
}

function markHot(settings: WizardSettings) {
  settings.hotChanges = true
}

function markRestart(settings: WizardSettings, reason: string) {
  settings.restartReasons.push(reason)
}

function uniqueReasons(settings: WizardSettings) {
  return [...new Set(settings.restartReasons)]
}

function setField(target: Record<string, unknown>, field: string, value: unknown) {
  if (value === "") {
    delete target[field]
    return
  }
  target[field] = value
}

function fieldValueAfterInput(value: unknown) {
  return value === "" ? undefined : value
}

function comparableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, comparableValue(item)]))
  }
  return value
}

function fieldValueChanged(previous: unknown, next: unknown) {
  return JSON.stringify(comparableValue(previous)) !== JSON.stringify(comparableValue(fieldValueAfterInput(next)))
}

function markFieldChange(settings: WizardSettings, field: string, reason: string) {
  if (isHotReloadField(field)) {
    markHot(settings)
    return
  }
  markRestart(settings, reason)
}

async function warnRestartField(api: TuiPluginApi, label: string, reason: string) {
  await showAlert(api.ui, {
    title: "Restart required",
    message: `${label} changes are saved, but OpenCode must be restarted before the task list/UI reflects them.\n\n${reason}`,
  })
}

function sourceLabel(input: {
  parent?: AgentEntry["parent"]
  variant?: VariantConfig
  field: PatchField
  mode: "parent" | "variant"
}) {
  if (input.mode === "parent") return patchHasValue(input.parent, input.field) ? "SRC:local" : "SRC:none"
  if (patchHasValue(input.variant, input.field)) return "SRC:local"
  if (input.parent && input.variant && patchHasValue(inheritedPatch(input.parent, input.variant), input.field)) return "SRC:inherit"
  return "SRC:none"
}

function fieldResult(input: { parent?: AgentEntry["parent"]; variant?: VariantConfig; field: PatchField; mode: "parent" | "variant" }) {
  if (input.mode === "parent") return input.parent?.[input.field]
  if (!input.parent || !input.variant) return input.variant?.[input.field]
  return effectiveVariantPatch(input.parent, input.variant)[input.field]
}

function defaultFieldValue(api: TuiPluginApi, config: SidecarConfig, input: { field: PatchField; mode: "parent" | "variant"; parentName?: string; variantKey?: string; variant?: VariantConfig; parent?: AgentEntry["parent"] }) {
  const agent = input.parentName
  const agentConfig = agent ? api.state.config.agent?.[agent] : undefined
  if (input.mode === "parent") {
    if (input.field === "model") return agentConfig?.model ?? "current/session model"
    if (input.field === "variant") return agentConfig?.variant ?? "provider default"
    if (input.field === "temperature") return agentConfig?.temperature ?? "provider/model default"
    if (input.field === "top_p") return agentConfig?.top_p ?? "provider/model default"
    if (input.field === "description") return agentConfig?.description ?? (agent ? BUILTIN_AGENT_DESCRIPTIONS[agent] : undefined) ?? "OpenCode/native description"
    if (input.field === "color") return agent ? agentConfig?.color ?? "OpenCode palette color" : "OpenCode palette color"
    if (input.field === "options") return agentConfig?.options ?? "no extra options"
    return "not set"
  }

  if (input.field === "description" && agent && input.variantKey && input.variant) {
    return generatedVariantDescription(agent, input.variantKey, { ...input.variant, description: undefined }, config)
  }
  if (input.field === "color" && agent) return "parent/OpenCode palette color"
  if (input.field === "model") return "inherited parent model or current/session model"
  if (input.field === "variant") return "provider default"
  if (input.field === "temperature") return "provider/model default"
  if (input.field === "top_p") return "provider/model default"
  if (input.field === "options") return "no extra options"
  return "not set"
}

function fieldDefaultDescription(api: TuiPluginApi, config: SidecarConfig, input: { field: PatchField; mode: "parent" | "variant"; parentName?: string; variantKey?: string; variant?: VariantConfig; parent?: AgentEntry["parent"] }) {
  return `default: ${truncate(formatInputValue(defaultFieldValue(api, config, input)) ?? "not set", 76)}`
}

function fieldListOption(api: TuiPluginApi, config: SidecarConfig, input: { field: FieldDef; parent?: AgentEntry["parent"]; variant?: VariantConfig; mode: "parent" | "variant"; parentName?: string; variantKey?: string; alias?: string }): FieldListOption {
  const source = sourceLabel({ parent: input.parent, variant: input.variant, field: input.field.key, mode: input.mode })
  const value = fieldResult({ parent: input.parent, variant: input.variant, field: input.field.key, mode: input.mode })
  const inherited = source === "SRC:inherit"
  return {
    title: input.field.label,
    value: input.field.key,
    description: value !== undefined ? `${inherited ? "inherited: " : ""}${truncate(formatInputValue(value) ?? String(value), 76)}` : fieldDefaultDescription(api, config, { field: input.field.key, mode: input.mode, parentName: input.parentName, variantKey: input.variantKey, variant: input.variant, parent: input.parent }),
    restart: !isHotReloadField(input.field.key),
    channel: true,
    channelLabel: input.mode === "parent" ? "propagation" : "inheritance",
    channelEnabled: input.mode === "parent"
      ? propagationEnabled(input.parent ?? {}, input.field.key)
      : inheritanceEnabled(input.variant ?? {}, input.field.key),
    previewColor: input.field.key === "color"
      ? resolveUiColor(api, value) ?? (input.mode === "parent" && input.parentName ? parentColor(api, config, input.parentName) : input.parentName && input.variantKey && input.variant ? variantColor(api, config, input.parentName, input.variantKey, input.variant) : undefined)
      : undefined,
  }
}

// Dialog wrappers. No JSX; component functions are called directly.

type UI = TuiPluginApi["ui"]

function showSelect<Value>(
  ui: UI,
  props: {
    title: string
    options: TuiDialogSelectOption<Value>[]
    placeholder?: string
    current?: Value
  },
): Promise<Value | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: Value | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(() =>
      ui.DialogSelect<Value>({
        title: props.title,
        placeholder: props.placeholder ?? "Type to filter...",
        options: props.options,
        current: props.current,
        flat: props.options.length < 15,
        onSelect: (opt) => {
          done(opt.value)
          ui.dialog.clear()
        },
      }),
      () => done(undefined),
    )
  })
}

type MenuChoice<Value> = { action: "select" | "inspect"; value: Value }

async function showMenu<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value }): Promise<Value | undefined> {
  let current = props.current
  while (true) {
    const choice = await showMenuOnce(api, { ...props, current })
    if (!choice) return undefined
    current = choice.value
    if (choice.action === "select") return choice.value
    const option = props.options.find((item) => item.value === choice.value)
    await showInfo(api, {
      title: option?.title ?? props.title,
      message: option?.help ?? option?.description ?? "No extra help is available for this option.",
    })
  }
}

function showMenuOnce<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value }): Promise<MenuChoice<Value> | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: MenuChoice<Value> | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <MenuDialog api={api} title={props.title} options={props.options} current={props.current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function MenuDialog<Value>(props: {
  api: TuiPluginApi
  title: string
  options: WizardSelectOption<Value>[]
  current?: Value
  onDone: (value: MenuChoice<Value> | undefined) => void
}) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const listHeight = createMemo(() => cappedHeight(props.options.length, wizardMaxRows(props.api, dimensions().height, 14, 6)))
  const titleWidth = createMemo(() => menuTitleWidth(wizardDialogSize(props.api), props.options))
  let scroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("agent-variants.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) => setSelected((value) => {
    const next = Math.max(0, Math.min(props.options.length - 1, value + delta))
    scroll?.scrollTo(Math.max(0, next - 2))
    return next
  })
  const choose = () => {
    const option = current()
    if (!option || option.disabled) return
    props.onDone({ action: "select", value: option.value })
  }
  const inspect = () => {
    const option = current()
    if (!option || option.disabled) return
    props.onDone({ action: "inspect", value: option.value })
  }
  const commandPrefix = `agent-variants.menu.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous item", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.down`, title: "Next item", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.select`, title: "Select item", run: (ctx: KeyContext) => { blockKey(ctx); choose() } },
      { name: `${commandPrefix}.inspect`, title: "Option help", run: (ctx: KeyContext) => { blockKey(ctx); inspect() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select item" },
      { key: "i", cmd: `${commandPrefix}.inspect`, desc: "Option help" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["i"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().text}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box flexDirection="row" gap={3} marginBottom={1}>
        <text fg={theme().textMuted}>enter select</text>
        <text fg={theme().textMuted}>up/down move</text>
        <text fg={theme().textMuted}>i help</text>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={props.options}>
          {(option, index) => {
            const active = createMemo(() => selected() === index())
            const fg = createMemo(() => active() ? theme().background : option.danger ? theme().error : option.color ?? theme().text)
            const descFg = createMemo(() => active() ? theme().background : theme().textMuted)
            return (
              <box
                flexDirection="row"
                width="100%"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme().primary : theme().backgroundPanel}
                onMouseOver={() => setSelected(index())}
                onMouseUp={() => {
                  if (!option.disabled) props.onDone({ action: "select", value: option.value })
                }}
              >
                <text width={titleWidth()} flexShrink={0} fg={fg()} wrapMode="none" overflow="hidden"><b>{option.title}</b></text>
                <text flexGrow={1} fg={descFg()} wrapMode="none" overflow="hidden">{option.description ?? ""}</text>
              </box>
            )
          }}
        </For>
      </box>
      </scrollbox>
    </box>
  )
}

function showFieldList(api: TuiPluginApi, props: { title: string; options: FieldListOption[]; current?: string; titleColor?: DisplayColor }): Promise<FieldListChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: FieldListChoice | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <FieldListDialog api={api} title={props.title} titleColor={props.titleColor} options={props.options} current={props.current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function FieldListDialog(props: {
  api: TuiPluginApi
  title: string
  titleColor?: DisplayColor
  options: FieldListOption[]
  current?: string
  onDone: (value: FieldListChoice | undefined) => void
}) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const listHeight = createMemo(() => cappedHeight(props.options.length, wizardMaxRows(props.api, dimensions().height, 15, 8)))
  let scroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("agent-variants.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) => {
    setSelected((value) => {
      const next = Math.max(0, Math.min(props.options.length - 1, value + delta))
      scroll?.scrollTo(Math.max(0, next - 2))
      return next
    })
  }
  const choose = (action: FieldListChoice["action"] = "select") => {
    const option = current()
    if (!option) return
    if (action !== "select" && option.kind === "action") return
    if (action === "toggle" && !option.channel) return
    props.onDone({ action, value: option.value })
  }
  const commandPrefix = `agent-variants.field-list.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous field", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.down`, title: "Next field", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.select`, title: "Select field", run: (ctx: KeyContext) => { blockKey(ctx); choose("select") } },
      { name: `${commandPrefix}.toggle`, title: "Toggle inheritance", run: (ctx: KeyContext) => { blockKey(ctx); choose("toggle") } },
      { name: `${commandPrefix}.inspect`, title: "Field info/help", run: (ctx: KeyContext) => { blockKey(ctx); choose("inspect") } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous field" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous field" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next field" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next field" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select field" },
      { key: "space", cmd: `${commandPrefix}.toggle`, desc: "Toggle inheritance/propagation" },
      { key: "i", cmd: `${commandPrefix}.inspect`, desc: "Field info/help" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["i", "space"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={props.titleColor ?? theme().text}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box flexDirection="column" gap={0} marginBottom={1}>
        <box flexDirection="row" gap={3}>
          <text fg={theme().textMuted}>enter edit</text>
          <text fg={theme().textMuted}>space toggle</text>
          <text fg={theme().textMuted}>i help</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().success}>■</text>
          <text fg={theme().textMuted}>inherits/propagates</text>
          <text fg={theme().error}>■</text>
          <text fg={theme().textMuted}>blocked</text>
        </box>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={props.options}>
          {(option, index) => {
            const active = createMemo(() => selected() === index())
            const fg = createMemo(() => active() ? theme().background : option.restart ? theme().error : theme().text)
            const valueFg = createMemo(() => active() ? theme().background : option.description.startsWith("inherited:") ? theme().success : option.description === "not set" ? theme().textMuted : theme().textMuted)
            return (
              <box
                flexDirection="row"
                width="100%"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option.previewColor ?? (active() ? theme().primary : theme().backgroundPanel)}
                onMouseOver={() => setSelected(index())}
                onMouseUp={() => props.onDone({ action: "select", value: option.value })}
              >
                <text width={24} flexShrink={0} fg={fg()} wrapMode="none"><b>{option.title}</b></text>
                <text flexGrow={1} fg={valueFg()} wrapMode="none" overflow="hidden">{option.description}</text>
                <Show when={option.channel}>
                  <box width={3} flexShrink={0} justifyContent="center">
                    <text fg={option.channelEnabled ? theme().success : theme().error}>■</text>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
      </scrollbox>
    </box>
  )
}

function showBackupList(api: TuiPluginApi, items: BackupListItem[]): Promise<BackupListChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: BackupListChoice | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <BackupListDialog api={api} items={items} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function BackupListDialog(props: { api: TuiPluginApi; items: BackupListItem[]; onDone: (value: BackupListChoice | undefined) => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const listHeight = createMemo(() => cappedHeight(props.items.length, wizardMaxRows(props.api, dimensions().height, 15, 8)))
  let scroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("agent-variants.dialog")
  const [selected, setSelected] = createSignal(0)
  const [pendingDelete, setPendingDelete] = createSignal<string | undefined>()
  const current = createMemo(() => props.items[selected()])
  const move = (delta: number) => setSelected((value) => {
    const next = Math.max(0, Math.min(props.items.length - 1, value + delta))
    if (next !== value) setPendingDelete(undefined)
    scroll?.scrollTo(Math.max(0, next - 2))
    return next
  })
  const select = () => {
    const item = current()
    if (item) props.onDone({ action: "select", item })
  }
  const deleteFull = () => {
    const item = current()
    if (!item || item.kind !== "full") return
    if (pendingDelete() !== item.id) {
      setPendingDelete(item.id)
      return
    }
    props.onDone({ action: "delete", item })
  }
  const commandPrefix = `agent-variants.backups.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous backup", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.down`, title: "Next backup", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.select`, title: "Preview backup", run: (ctx: KeyContext) => { blockKey(ctx); select() } },
      { name: `${commandPrefix}.delete`, title: "Delete full backup", run: (ctx: KeyContext) => { blockKey(ctx); deleteFull() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous backup" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous backup" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next backup" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next backup" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Preview backup" },
      { key: "ctrl+d", cmd: `${commandPrefix}.delete`, desc: "Delete full backup" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>Config backups</b></text>
        <text fg={theme().textMuted}>esc</text>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={props.items}>
          {(item, index) => {
            const active = createMemo(() => selected() === index())
            const confirming = createMemo(() => item.kind === "full" && pendingDelete() === item.id)
            const fg = createMemo(() => active() || confirming() ? theme().background : item.kind === "patch" && !item.valid ? theme().error : item.kind === "full" ? theme().success : theme().text)
            return (
              <box
                flexDirection="row"
                width="100%"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={confirming() ? theme().error : active() ? theme().primary : theme().backgroundPanel}
                onMouseOver={() => { setSelected(index()); setPendingDelete(undefined) }}
                onMouseUp={() => props.onDone({ action: "select", item })}
              >
                <text width={34} flexShrink={0} fg={fg()} wrapMode="none" overflow="hidden"><b>{confirming() ? "Press ctrl+d again to confirm" : item.title}</b></text>
                <text flexGrow={1} fg={active() || confirming() ? theme().background : theme().textMuted} wrapMode="none" overflow="hidden">{item.description}</text>
              </box>
            )
          }}
        </For>
      </box>
      </scrollbox>
      <box flexDirection="row" gap={3} marginTop={1}>
        <text fg={theme().textMuted}>enter preview</text>
        <text fg={theme().textMuted}>delete full backup ctrl+d</text>
      </box>
    </box>
  )
}

function showPrompt(
  ui: UI,
  props: {
    title: string
    description?: string
    placeholder?: string
    value?: string
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(() =>
      ui.DialogPrompt({
        title: props.title,
        placeholder: props.placeholder,
        value: props.value ?? "",
        onConfirm: (val) => {
          done(val)
          ui.dialog.clear()
        },
        onCancel: () => {
          done(undefined)
          ui.dialog.clear()
        },
      }),
      () => done(undefined),
    )
  })
}

function showDescriptionPrompt(
  api: TuiPluginApi,
  props: {
    title: string
    placeholder?: string
    value?: string
  },
): Promise<string | "__preset__" | undefined> {
  return new Promise((resolve) => {
    let unregister: (() => void) | undefined
    let settled = false
    const done = (value: string | "__preset__" | undefined) => {
      if (settled) return
      settled = true
      unregister?.()
      resolve(value)
    }
    const commandPrefix = `agent-variants.description.${Math.random().toString(36).slice(2)}`
    unregister = api.keymap.registerLayer({
      priority: 10000,
      commands: [
        { name: `${commandPrefix}.preset`, title: "Pick description preset", run: (ctx: KeyContext) => { blockKey(ctx); done("__preset__"); api.ui.dialog.clear() } },
      ],
      bindings: [{ key: "ctrl+p", cmd: `${commandPrefix}.preset`, desc: "Pick description preset" }],
    })
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: props.title,
        placeholder: props.placeholder ?? "Enter text, or press ctrl+p for presets",
        value: props.value ?? "",
        onConfirm: (val) => {
          done(val)
          api.ui.dialog.clear()
        },
        onCancel: () => {
          done(undefined)
          api.ui.dialog.clear()
        },
      }),
      () => done(undefined),
    )
  })
}

function showConfirm(
  ui: UI,
  props: {
    title: string
    message: string
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(() =>
      ui.DialogConfirm({
        title: props.title,
        message: props.message,
        onConfirm: () => {
          done(true)
          ui.dialog.clear()
        },
        onCancel: () => {
          done(false)
          ui.dialog.clear()
        },
      }),
      () => done(false),
    )
  })
}

function showAlert(ui: UI, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    ui.dialog.replace(() =>
      ui.DialogAlert({
        title: props.title,
        message: props.message,
        onConfirm: () => {
          done()
          ui.dialog.clear()
        },
      }),
      done,
    )
  })
}

function showInfo(api: TuiPluginApi, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <InfoDialog api={api} title={props.title} message={props.message} onDone={done} />,
      done,
    )
  })
}

type HeightSliderChoice = { action: "save" | "custom"; value: number }

async function showHeightSlider(api: TuiPluginApi, config: SidecarConfig): Promise<number | undefined> {
  let current = effectiveUiHeightPercent(config.ui)
  while (true) {
    const choice = await showHeightSliderOnce(api, current)
    if (!choice) return undefined
    current = choice.value
    if (choice.action === "save") return current

    const input = await showPrompt(api.ui, {
      title: "Wizard UI height percent",
      placeholder: `${HEIGHT_PERCENT_MIN}-${HEIGHT_PERCENT_MAX}`,
      value: String(current),
    })
    if (input === undefined) continue
    const value = Number(input)
    if (!Number.isFinite(value)) {
      await showAlert(api.ui, { title: "Invalid height", message: `Enter a number from ${HEIGHT_PERCENT_MIN} to ${HEIGHT_PERCENT_MAX}.` })
      continue
    }
    current = clampHeightPercent(value)
  }
}

function showHeightSliderOnce(api: TuiPluginApi, current: number): Promise<HeightSliderChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: HeightSliderChoice | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <HeightSliderDialog api={api} current={current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function HeightSliderDialog(props: { api: TuiPluginApi; current: number; onDone: (value: HeightSliderChoice | undefined) => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const [value, setValue] = createSignal(clampHeightPercent(props.current))
  const popMode = props.api.mode.push("agent-variants.dialog")
  const commandPrefix = `agent-variants.height.${Math.random().toString(36).slice(2)}`
  const setPreset = (height: DialogHeight) => setValue(heightPresetPercent(height))
  const move = (delta: number) => setValue((current) => clampHeightPercent(current + delta))
  const sliderWidth = createMemo(() => wizardDialogSize(props.api) === "xlarge" ? 64 : wizardDialogSize(props.api) === "large" ? 48 : 34)
  const sliderCells = createMemo(() => {
    const width = sliderWidth()
    const selected = Math.round(((value() - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1))
    const presetPositions = new Map(HEIGHT_PRESETS.map((preset) => [Math.round(((preset.value - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1)), preset.label]))
    return Array.from({ length: width }, (_, index) => {
      const current = index === selected
      const preset = presetPositions.get(index)
      return {
        char: current ? "●" : preset ? "│" : index < selected ? "━" : "─",
        color: current ? theme().primary : preset ? theme().accent : index < selected ? theme().success : theme().textMuted,
      }
    })
  })
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.left`, title: "Lower height", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.right`, title: "Raise height", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.down`, title: "Lower height faster", run: (ctx: KeyContext) => { blockKey(ctx); move(-5) } },
      { name: `${commandPrefix}.up`, title: "Raise height faster", run: (ctx: KeyContext) => { blockKey(ctx); move(5) } },
      { name: `${commandPrefix}.compact`, title: "Compact preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("compact") } },
      { name: `${commandPrefix}.normal`, title: "Normal preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("normal") } },
      { name: `${commandPrefix}.tall`, title: "Tall preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("tall") } },
      { name: `${commandPrefix}.max`, title: "Max preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("max") } },
      { name: `${commandPrefix}.custom`, title: "Custom percent", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone({ action: "custom", value: value() }) } },
      { name: `${commandPrefix}.save`, title: "Save height", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone({ action: "save", value: value() }) } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "left", cmd: `${commandPrefix}.left`, desc: "Lower height" },
      { key: "right", cmd: `${commandPrefix}.right`, desc: "Raise height" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Lower height faster" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Raise height faster" },
      { key: "1", cmd: `${commandPrefix}.compact`, desc: "Compact preset" },
      { key: "2", cmd: `${commandPrefix}.normal`, desc: "Normal preset" },
      { key: "3", cmd: `${commandPrefix}.tall`, desc: "Tall preset" },
      { key: "4", cmd: `${commandPrefix}.max`, desc: "Max preset" },
      { key: "c", cmd: `${commandPrefix}.custom`, desc: "Custom percent" },
      { key: "enter", cmd: `${commandPrefix}.save`, desc: "Save height" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["1", "2", "3", "4", "c"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>Wizard UI height</b></text>
        <text fg={theme().textMuted}>esc</text>
      </box>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().textMuted}>Current</text>
        <text fg={theme().primary}><b>{value()}%</b></text>
      </box>
      <box flexDirection="row" width="100%" marginBottom={1}>
        <text fg={theme().textMuted}>{HEIGHT_PERCENT_MIN}% </text>
        <For each={sliderCells()}>{(cell) => <text fg={cell.color}>{cell.char}</text>}</For>
        <text fg={theme().textMuted}> {HEIGHT_PERCENT_MAX}%</text>
      </box>
      <box flexDirection="column" gap={0} marginBottom={1}>
        <For each={HEIGHT_PRESETS}>
          {(preset) => <text fg={value() === preset.value ? theme().primary : theme().textMuted}>{preset.key} {preset.label}: {preset.value}%</text>}
        </For>
      </box>
      <box flexDirection="column" gap={0} marginBottom={1}>
        <text fg={theme().textMuted}>left/right adjust 1%</text>
        <text fg={theme().textMuted}>up/down adjust 5%</text>
        <text fg={theme().textMuted}>c custom percent</text>
      </box>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg={theme().textMuted}>enter save</text>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={() => props.onDone({ action: "save", value: value() })}>
          <text fg={theme().background}><b>save</b></text>
        </box>
      </box>
    </box>
  )
}

function InfoDialog(props: { api: TuiPluginApi; title: string; message: string; onDone: () => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const popMode = props.api.mode.push("agent-variants.dialog")
  const lines = createMemo(() => props.message.split(/\r?\n/))
  const visualRows = createMemo(() => estimatedVisualRows(props.message, dialogContentWidth(props.api)))
  const bodyHeight = createMemo(() => cappedHeight(visualRows() + 1, wizardMaxRows(props.api, dimensions().height, 13, 4), 4))
  let scroll: ScrollBoxRenderable | undefined
  const page = () => Math.max(1, (scroll?.height ?? bodyHeight()) - 1)
  const commandPrefix = `agent-variants.info.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.close`, title: "Close", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone() } },
      { name: `${commandPrefix}.up`, title: "Scroll up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-1) } },
      { name: `${commandPrefix}.down`, title: "Scroll down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(1) } },
      { name: `${commandPrefix}.pageUp`, title: "Page up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-page()) } },
      { name: `${commandPrefix}.pageDown`, title: "Page down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(page()) } },
      { name: `${commandPrefix}.home`, title: "Scroll top", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollTo(0) } },
      { name: `${commandPrefix}.end`, title: "Scroll bottom", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollTo(scroll.scrollHeight) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Scroll up" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Scroll up" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Scroll down" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Scroll down" },
      { key: "pageup", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "ctrl+b", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "pagedown", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "ctrl+f", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "home", cmd: `${commandPrefix}.home`, desc: "Scroll top" },
      { key: "end", cmd: `${commandPrefix}.end`, desc: "Scroll bottom" },
      ...shieldBindings(`${commandPrefix}.shield`, ["home", "end"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={props.onDone}>esc</text>
      </box>
      <scrollbox maxHeight={bodyHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={lines()}>
          {(line) => {
            const heading = line.length > 0 && !line.startsWith(" ") && (line.endsWith(":") || /^[A-Z][A-Za-z ]+$/.test(line))
            const warning = /restart|required|red/i.test(line)
            const positive = /hot reload|yes|saved|enabled/i.test(line)
            return line.length === 0
              ? <text> </text>
              : <text fg={warning ? theme().error : positive ? theme().success : heading ? theme().accent : theme().textMuted} wrapMode="word">{heading ? <b>{line}</b> : line}</text>
          }}
        </For>
      </box>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg={theme().textMuted}>{visualRows() > bodyHeight() ? "up/down scroll" : ""}</text>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={props.onDone}>
          <text fg={theme().background}><b>ok</b></text>
        </box>
      </box>
    </box>
  )
}

function showFieldAction(
  api: TuiPluginApi,
  props: { title: string; inspect: () => string; toggleLabel: string },
): Promise<"set" | "toggle" | "inspect" | "back" | undefined> {
  return showSelect(api.ui, {
    title: props.title,
    options: [
      { title: "Set/edit value", value: "set", description: "Submit an empty value to remove the local override" },
      { title: props.toggleLabel, value: "toggle", description: "Change inheritance/propagation for this field" },
      { title: "Field info/help", value: "inspect", description: truncate(props.inspect().replace(/\n/g, "  "), 120) },
      { title: "< Back", value: "back", description: "Return to field list" },
    ],
  }) as Promise<"set" | "toggle" | "inspect" | "back" | undefined>
}

function inspectParentField(api: TuiPluginApi, config: SidecarConfig, agent: string, parent: AgentEntry["parent"], field: PatchField) {
  const def = fieldDef(field)
  const value = parent[field]
  const help = FIELD_HELP[field]
  const defaultValue = defaultFieldValue(api, config, { field, mode: "parent", parentName: agent, parent })
  return [
    `${def?.label ?? field} (${agent} parent)`,
    "",
    help.purpose,
    "",
    help.parent,
    "",
    `Hot reload: ${isHotReloadField(field) ? "yes" : "no, restart required"}`,
    `Default value: ${formatInputValue(defaultValue) ?? "not set"}`,
    `Local value: ${value === undefined ? "not set" : formatInputValue(value)}`,
    `Propagates to variants: ${propagationEnabled(parent, field) ? "yes" : "no"}`,
    `Resulting parent value: ${value === undefined ? "not set" : formatInputValue(value)}`,
    "",
    help.empty,
    "Submitting an empty value in the editor removes the local override. Escape cancels without changes.",
  ].join("\n")
}

function inspectVariantField(api: TuiPluginApi, config: SidecarConfig, agent: string, key: string, parent: AgentEntry["parent"], variant: VariantConfig, field: PatchField) {
  const def = fieldDef(field)
  const help = FIELD_HELP[field]
  const inherited = inheritedPatch(parent, variant)[field]
  const local = variant[field]
  const result = effectiveVariantPatch(parent, variant)[field]
  const defaultValue = defaultFieldValue(api, config, { field, mode: "variant", parentName: agent, variantKey: key, parent, variant })
  const materializedPreset = field === "description" && typeof local === "string"
    ? SELECTION_PRESETS.find((preset) => local === generatedVariantBase(agent, key, variant, config, preset.key))
    : undefined
  const preset = field === "description" ? materializedPreset ?? inferredSelectionPreset(agent, key, variant, config) : undefined
  const presetState = field === "description"
    ? local !== undefined
      ? materializedPreset ? `${materializedPreset.title} (materialized in local Description)` : "overwritten by local Description value"
      : preset
        ? `${preset.title} (auto-inferred)`
        : "generic exact-alias guidance (auto)"
    : undefined
  const presetText = field === "description" && preset ? renderedSelectionPresetText(config, agent, key, variant, preset.key) : undefined
  return [
    `${def?.label ?? field} (${variantName(agent, key, variant)})`,
    "",
    help.purpose,
    "",
    help.variant,
    "",
    `Hot reload: ${isHotReloadField(field) ? "yes" : "no, restart required"}`,
    `Default value: ${formatInputValue(defaultValue) ?? "not set"}`,
    `Local value: ${local === undefined ? "not set" : formatInputValue(local)}`,
    `Variant accepts inheritance: ${inheritanceEnabled(variant, field) ? "yes" : "no"}`,
    `Parent propagates this field: ${propagationEnabled(parent, field) ? "yes" : "no"}`,
    `Inherited value: ${inherited === undefined ? "not available" : formatInputValue(inherited)}`,
    `Resulting value: ${result === undefined ? "not set" : formatInputValue(result)}`,
    `Source: ${local !== undefined ? "local variant override" : inherited !== undefined ? "inherited parent override" : "none"}`,
    ...(field === "description" ? [
      `Selection preset: ${presetState}`,
      ...(presetText ? ["Preset text:", presetText] : []),
      "Resulting task-list description:",
      generatedVariantDescription(agent, key, variant, config),
    ] : []),
    "",
    help.empty,
    "Submitting an empty value in the editor removes the local override. Escape cancels without changes.",
  ].join("\n")
}

function inspectVariantName(agent: string, key: string, variant: VariantConfig) {
  return [
    `Display name (${variantName(agent, key, variant)})`,
    "",
    "Controls the generated alias shown in OpenCode's task list after restart.",
    "",
    "Hot reload: no, restart required",
    `Default value: ${agent}-${key}`,
    `Local value: ${variant.name ?? "not set"}`,
    `Resulting value: ${variantName(agent, key, variant)}`,
    "",
    "Submitting an empty value removes the custom display name. Escape cancels without changes.",
  ].join("\n")
}

// Main wizard flows.

async function addVariant(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
  const agents = selectableParentAgents(api, config, settings)
  if (agents.length === 0) {
    await showAlert(api.ui, {
      title: "No agents",
      message: settings.subagentCapableOnly
        ? "No subagent-capable agents are available. Open Debug & advanced and disable the parent filter only if you need to inspect or repair existing config."
        : "No agents available to add a variant to.",
    })
    return config
  }

  const agentOpts: WizardSelectOption<string>[] = agents.map((a) => ({
    title: a,
    value: a,
    description: `${agentMode(api, a)} - ${BUILTIN_AGENT_DESCRIPTIONS[a] ?? api.state.config.agent?.[a]?.description ?? "Configured agent"}`,
    color: parentColor(api, config, a),
  }))
  const agent = await showMenu(api, { title: "Add variant - pick parent agent", options: agentOpts })
  if (!agent) return config
  if (settings.subagentCapableOnly && !isSubagentCapableMode(agentMode(api, agent))) {
    await showAlert(api.ui, {
      title: "Primary-only agent",
      message: `"${agent}" is primary-only and cannot be used by the task tool. Agent Variants are intended for subagents.`,
    })
    api.ui.toast({ variant: "warning", title: "Variant not added", message: `${agent} is primary-only.` })
    return config
  }

  const existingKeys = Object.keys(config.agents[agent]?.variants ?? {})
  const defaultKey = existingKeys.length === 0 ? "light" : undefined
  const key = await showPrompt(api.ui, {
    title: `Variant key for "${agent}"`,
    description: `This becomes the alias name (e.g. "${agent}-<key>"). Must be unique per agent.`,
    placeholder: defaultKey ?? "variant-key",
    value: defaultKey,
  })
  if (!key) return config
  if (existingKeys.includes(key)) {
    await showAlert(api.ui, { title: "Duplicate key", message: `"${key}" already exists for "${agent}".` })
    return config
  }

  const next = structuredClone(config)
  if (!next.agents[agent]) {
    next.agents[agent] = { parent: {}, variants: {} }
  }

  const variant = await editVariantFields(api, next, {}, agent, key)
  next.agents[agent].variants[key] = variant

  const name = variantName(agent, key, variant)
  markRestart(settings, `${name}: added variant requires restart before it appears in the task list.`)
  await warnRestartField(api, "Variant added", "New variants are added to OpenCode's cached task list only at startup.")
  return next
}

/** Model preset manager (self-contained submenu; shared by both hosts). */
export async function manageModelPresets(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const options: WizardSelectOption<string>[] = [
    {
      title: "Add model preset",
      value: "__add__",
      description: "Create a shortcut like light or heavy",
      help: "Create a reusable model preset. Presets appear in every Model picker and can include model, model variant, temperature, top_p, and provider options.",
    },
    ...Object.entries(config.models).map(([key, entry]) => ({
      title: key,
      value: key,
      description: modelPresetDescription(entry),
      help: modelPresetHelp(key, entry),
    })),
    { title: "< Back", value: "__back__", description: "Return to main menu" },
  ]
  const picked = await showMenu(api, { title: "Model presets", options })
  if (!picked || picked === "__back__") return config

  const next = structuredClone(config)
  if (picked === "__add__") {
    const key = await showPrompt(api.ui, { title: "Preset key", placeholder: "light", value: "light" })
    if (!key) return config
    if (next.models[key]) {
      await showAlert(api.ui, { title: "Duplicate preset", message: `Model preset "${key}" already exists.` })
      return manageModelPresets(api, config)
    }
    const edited = await editModelPreset(api, next, key, { model: "" })
    if (edited.model) next.models[key] = edited
    return manageModelPresets(api, next)
  }

  next.models[picked] = await editModelPreset(api, next, picked, next.models[picked] as ModelShortcut)
  if (!next.models[picked]?.model) delete next.models[picked]
  return manageModelPresets(api, next)
}

async function editModelPreset(api: TuiPluginApi, config: SidecarConfig, key: string, initial: ModelShortcut): Promise<ModelShortcut> {
  const preset: Record<string, unknown> = { ...initial }
  let selected: string | undefined = "model"
  while (true) {
    const options: WizardSelectOption<string>[] = [
      ...MODEL_PRESET_FIELDS.map((field) => ({
        title: field.label,
        value: field.key,
        description: preset[field.key] === undefined || preset[field.key] === ""
          ? field.required ? "required" : "default: not set"
          : truncate(formatInputValue(preset[field.key]) ?? String(preset[field.key]), 76),
        help: modelPresetFieldHelp(field.key, key, preset[field.key]),
      })),
      { title: "Delete preset", value: "__delete__", description: "Remove this model preset", danger: true, help: "Deletes this preset from the sidecar. Existing variants that still reference it will fail diagnostics until changed." },
      { title: "< Back", value: "__back__", description: "Return to model presets" },
    ]
    const picked: string | undefined = await showMenu(api, { title: `Model preset - ${key}`, options, current: selected })
    if (!picked || picked === "__back__") return preset as ModelShortcut
    selected = picked
    if (picked === "__delete__") {
      const confirmed = await showConfirm(api.ui, { title: "Delete model preset?", message: `Remove "${key}"?` })
      if (confirmed) return { model: "" }
      continue
    }

    const before = preset[picked]
    const value = picked === "label"
      ? await showPrompt(api.ui, { title: "Label", placeholder: key, value: formatInputValue(before) })
      : await promptForField(api, picked, formatInputValue(before), { config, model: preset.model, includeModelPresets: false })
    if (value === undefined) continue
    setField(preset, picked, value)
    if (picked === "model" && before !== value) {
      delete preset.variant
      const oldLabel = typeof before === "string" ? modelDisplayName(api, config, before) : undefined
      const nextLabel = modelDisplayName(api, config, value)
      if (nextLabel && (preset.label === undefined || preset.label === "" || preset.label === oldLabel)) preset.label = nextLabel
    }
  }
}

function modelPresetFieldHelp(field: keyof ModelShortcut, key: string, value: unknown) {
  const base = [`Model preset "${key}".`, "", `Default value: ${field === "model" ? "required" : "not set"}`, `Current value: ${formatInputValue(value) ?? "not set"}`, ""]
  if (field === "model") return [...base, "Required provider/model reference. This is what the preset selects when a parent or variant uses this shortcut in its Model field."].join("\n")
  if (field === "label") return [...base, "Optional human label shown in descriptions and pickers. When you pick a known model, this is prefilled from the model display name unless you already customized it."].join("\n")
  if (field === "variant") return [...base, "Optional provider model variant, such as low, medium, high, or xhigh when the selected model exposes variants."].join("\n")
  if (field === "temperature") return [...base, "Optional temperature applied with the preset unless the parent or variant has a local Temperature override."].join("\n")
  if (field === "top_p") return [...base, "Optional top_p applied with the preset unless locally overridden."].join("\n")
  return [...base, "Optional provider/model request options JSON object applied with the preset."].join("\n")
}

/** Pre-scoped parent-field editor (propagation/override per field). */
export async function editParentFields(
  api: TuiPluginApi,
  config: SidecarConfig,
  agent: string,
  settings: WizardSettings,
): Promise<SidecarConfig> {
  const next = structuredClone(config)
  if (!next.agents[agent]) next.agents[agent] = { parent: {}, variants: {} }
  let selectedField: string | undefined = EDITABLE_FIELDS[0]?.key

  while (true) {
    const parent = (next.agents[agent] as AgentEntry).parent
    const fieldOpts: FieldListOption[] = [
      ...EDITABLE_FIELDS.map((field) => fieldListOption(api, next, { field, parent, mode: "parent", parentName: agent })),
      { title: "< Back", value: "__back__", description: "Return to main menu", kind: "action" },
    ]

    const pickedField = await showFieldList(api, { title: `Edit parent fields - ${agent}`, options: fieldOpts, current: selectedField, titleColor: parentColor(api, next, agent) })
    const field = pickedField?.value
    if (!field || field === "__back__") return next
    selectedField = field

    const picked = fieldDef(field)
    if (!picked) continue
    if (pickedField.action === "inspect") {
      await showInfo(api, { title: picked.label, message: inspectParentField(api, next, agent, parent, picked.key) })
      continue
    }
    if (pickedField.action === "toggle") {
      parent.propagate = { ...(parent.propagate ?? {}), [picked.key]: !propagationEnabled(parent, picked.key) }
      markFieldChange(settings, picked.key, `${agent}: ${picked.label} propagation requires restart.`)
      if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "Propagation for this field affects cached task-list/UI metadata.")
      continue
    }
    const value = await promptForField(api, field, formatInputValue(parent[picked.key]), { config: next, model: parent.model })
    if (value === undefined) continue
    const previous = parent[picked.key]
    if (!fieldValueChanged(previous, value)) continue
    setField(parent as Record<string, unknown>, picked.key, value)
    if (picked.key === "model" && previous !== value) delete parent.variant
    markFieldChange(settings, picked.key, `${agent}: ${picked.label} requires restart.`)
    if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "This field is stored in OpenCode's cached agent/task-list metadata.")
  }
}

async function editVariantFields(
  api: TuiPluginApi,
  config: SidecarConfig,
  initial: VariantConfig,
  agent: string,
  key: string,
): Promise<VariantConfig> {
  const variant: Record<string, unknown> = { ...initial }

  const wantModel = await showConfirm(api.ui, {
    title: "Set model?",
    message: `Choose a model for variant "${key}" of "${agent}"?`,
  })
  if (wantModel) {
    const models = modelOptions(api, config)
    const picked = await showSelect(api.ui, { title: "Select model", options: models })
    if (picked) {
      if (picked === "__custom__") {
        const custom = await showPrompt(api.ui, {
          title: "Custom model ID",
          placeholder: "provider/model-id",
          value: variant.model as string | undefined,
        })
        if (custom) variant.model = custom
      } else {
        variant.model = picked
      }
    }
  }

  const wantName = await showConfirm(api.ui, {
    title: "Custom display name?",
    message: `Default is "${agent}-${key}". Set a custom name?`,
  })
  if (wantName) {
    const name = await showPrompt(api.ui, {
      title: "Variant display name",
      value: variant.name as string | undefined,
      placeholder: `${agent}-${key}`,
    })
    if (name) variant.name = name
  }

  const inferred = inferredSelectionPreset(agent, key, variant as VariantConfig, config)
  const presetChoice = await pickSelectionPreset(api, config, agent, key, variant as VariantConfig, true)
  if (presetChoice && presetChoice !== "__auto__") {
    variant.description = generatedVariantBase(agent, key, variant as VariantConfig, config, presetChoice)
  } else if (inferred) {
    api.ui.toast({
      variant: "info",
      title: "Description guidance auto-selected",
      message: `${variantName(agent, key, variant as VariantConfig)} will use ${inferred.title} unless you replace Description.`,
    })
  }

  const more = await showConfirm(api.ui, {
    title: "Edit more fields?",
    message: "Set temperature, prompt overrides, color, etc.?",
  })
  if (!more) return variant as VariantConfig

  const remaining = EDITABLE_FIELDS.filter((f) => f.key !== "model")
  for (const field of remaining) {
    if (field.key === "color") {
      const wantColor = await showConfirm(api.ui, {
        title: "Set color?",
        message: `Current: ${variant.color ?? "(not set)"}`,
      })
      if (wantColor) {
        const picked = await showMenu(api, { title: "Pick color", options: colorOptions(api) })
        if (picked === "__custom__") {
          const hex = await showPrompt(api.ui, { title: "Hex color", placeholder: "#FF5733", value: variant.color as string | undefined })
          if (hex) variant.color = hex
        } else if (picked) {
          variant.color = picked
        }
      }
      continue
    }

    if (variant[field.key] !== undefined) continue

    const want = await showConfirm(api.ui, {
      title: `Set ${field.label}?`,
      message: `Not set. Configure this field?`,
    })
    if (!want) continue

    const value = await promptForField(api, field.key, formatInputValue(variant[field.key]), { config, model: variant.model, descriptionVariant: { agent, key, variant: variant as VariantConfig } })
    if (value !== undefined && value !== "") {
      variant[field.key] = value
    }
  }

  return variant as VariantConfig
}

async function editVariant(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
  const agentsWithVariants = agentEntries(config).filter(([, e]) => Object.keys(e.variants).length > 0)
  if (agentsWithVariants.length === 0) {
    await showAlert(api.ui, { title: "No variants", message: "Add a variant first." })
    return config
  }

  const agentOpts: WizardSelectOption<string>[] = agentsWithVariants.map(([a, e]) => ({
    title: a,
    value: a,
    description: `${Object.keys(e.variants).length} variant(s)`,
    color: parentColor(api, config, a),
  }))
  const agent = await showMenu(api, { title: "Edit variant - pick agent", options: agentOpts })
  if (!agent) return config

  const entries = variantEntries(config.agents[agent] as AgentEntry)
  const varOpts: WizardSelectOption<string>[] = entries.map(([k, v]) => ({
    title: `${variantName(agent, k, v)}  (${k})`,
    value: k,
    description: modelDescription(v.model, config),
    color: variantColor(api, config, agent, k, v),
  }))
  const key = await showMenu(api, { title: `Edit variant of "${agent}"`, options: varOpts })
  if (!key) return config

  const next = structuredClone(config)
  let selectedField: string | undefined = EDITABLE_FIELDS[0]?.key
  while (true) {
    const nextEntry = next.agents[agent] as AgentEntry
    const parent = nextEntry.parent
    const target = nextEntry.variants[key] as VariantConfig & Record<string, unknown>
    const fieldOpts: FieldListOption[] = [
      ...EDITABLE_FIELDS.map((field) => fieldListOption(api, next, { field, parent, variant: target, mode: "variant", parentName: agent, variantKey: key, alias: variantName(agent, key, target) })),
      {
        title: "Display name",
        value: "name",
        description: target.name ? String(target.name) : `default: ${agent}-${key}`,
        restart: true,
      },
      { title: "< Back", value: "__back__", description: "Return to variant picker", kind: "action" },
    ]

    const pickedField = await showFieldList(api, { title: `Edit field - ${variantName(agent, key, target)}`, options: fieldOpts, current: selectedField, titleColor: variantColor(api, next, agent, key, target) })
    const field = pickedField?.value
    if (!field || field === "__back__") return next
    selectedField = field

    if (field === "name") {
      if (pickedField.action === "inspect") {
        await showInfo(api, { title: "Display name", message: inspectVariantName(agent, key, target) })
        continue
      }
      const val = await showPrompt(api.ui, { title: "Display name", value: target.name as string | undefined, placeholder: `${agent}-${key}` })
      if (val === undefined) continue
      const previous = target.name
      if (!fieldValueChanged(previous, val)) continue
      if (val === "") delete target.name
      if (val !== "") target.name = val
      markRestart(settings, `${agent}.${key}: display name requires restart.`)
      await warnRestartField(api, "Display name", "Generated agent names are cached by OpenCode's task list.")
      continue
    }

    if (!EDITABLE_FIELD_KEYS.has(field as PatchField)) continue
    const picked = fieldDef(field)
    if (!picked) continue
    if (pickedField.action === "inspect") {
      await showInfo(api, { title: picked.label, message: inspectVariantField(api, next, agent, key, nextEntry.parent, target, picked.key) })
      continue
    }
    if (pickedField.action === "toggle") {
      target.inherit = { ...(target.inherit ?? {}), [picked.key]: !inheritanceEnabled(target, picked.key) }
      markFieldChange(settings, picked.key, `${variantName(agent, key, target)}: ${picked.label} inheritance requires restart.`)
      if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "Inheritance for this field affects cached task-list/UI metadata.")
      continue
    }
    const val = await promptForField(api, field, formatInputValue(target[picked.key]), {
      config: next,
      model: effectiveVariantPatch(nextEntry.parent, target).model,
      descriptionVariant: { agent, key, variant: target },
    })
    if (val === undefined) continue
    const previous = target[picked.key]
    if (!fieldValueChanged(previous, val)) continue
    setField(target, picked.key, val)
    if (picked.key === "model" && previous !== val) delete target.variant
    markFieldChange(settings, picked.key, `${variantName(agent, key, target)}: ${picked.label} requires restart.`)
    if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "This field is stored in OpenCode's cached agent/task-list metadata.")
  }
}

async function toggleDisable(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
  const items: WizardSelectOption<{ agent: string; variant?: string }>[] = []

  for (const [agent, raw] of agentEntries(config)) {
    const entry = raw as AgentEntry
    const parentDisabled = entry.disable === true
    items.push({
      title: `${parentDisabled ? "x" : "ok"} ${agent} (parent)`,
      value: { agent },
      description: parentDisabled ? "Disabled - no variants active" : "Enabled",
      category: "Parents",
      color: parentColor(api, config, agent),
      danger: parentDisabled,
    })
    for (const [key, rawVar] of variantEntries(entry)) {
      const variant = rawVar as VariantConfig
      const vDisabled = variant.disable === true
      items.push({
        title: `  ${vDisabled ? "x" : "ok"} ${variantName(agent, key, variant)}`,
        value: { agent, variant: key },
        description: vDisabled ? "Disabled" : "Enabled",
        category: "Variants",
        color: variantColor(api, config, agent, key, variant),
        danger: vDisabled,
      })
    }
  }

  if (items.length === 0) {
    await showAlert(api.ui, { title: "Nothing to toggle", message: "Add agents or variants first." })
    return config
  }

  items.push({
    title: "< Back",
    value: { agent: "__back__" },
    description: "Return to main menu",
  })

  const picked = await showMenu(api, { title: "Toggle disable", options: items })
  if (!picked || picked.agent === "__back__") return config

  const next = structuredClone(config)

  if (!picked.variant) {
    if (!next.agents[picked.agent]) {
      next.agents[picked.agent] = { parent: {}, variants: {} }
    }
    const entry = next.agents[picked.agent] as AgentEntry
    entry.disable = !entry.disable
    const state = entry.disable ? "disabled" : "enabled"
    markRestart(settings, `${picked.agent}: parent ${state} requires restart.`)
    await warnRestartField(api, "Parent disable", `Parent ${state}; restart OpenCode to update task-list visibility.`)
  } else {
    const entry = next.agents[picked.agent] as AgentEntry | undefined
    const variant = entry?.variants[picked.variant] as VariantConfig | undefined
    if (variant) {
      variant.disable = !variant.disable
      const state = variant.disable ? "disabled" : "enabled"
      markRestart(settings, `${variantName(picked.agent, picked.variant, variant)}: variant ${state} requires restart.`)
      await warnRestartField(api, "Variant disable", `Variant ${state}; restart OpenCode to update task-list visibility.`)
    }
  }

  return next
}

async function deleteVariant(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
  const agentsWithVariants = agentEntries(config).filter(([, e]) => Object.keys(e.variants).length > 0)
  if (agentsWithVariants.length === 0) {
    await showAlert(api.ui, { title: "No variants", message: "Nothing to delete." })
    return config
  }

  const agentOpts: WizardSelectOption<string>[] = agentsWithVariants.map(([a]) => ({
    title: a,
    value: a,
    color: parentColor(api, config, a),
  }))
  const agent = await showMenu(api, { title: "Delete variant - pick agent", options: agentOpts })
  if (!agent) return config

  const agentEntry = config.agents[agent] as AgentEntry
  const entries = variantEntries(agentEntry)
  const varOpts: WizardSelectOption<string>[] = entries.map(([k, v]) => ({
    title: `${variantName(agent, k, v)}  (${k})`,
    value: k,
    description: modelDescription(v.model, config),
    color: variantColor(api, config, agent, k, v),
    danger: true,
  }))
  const key = await showMenu(api, { title: `Delete variant from "${agent}"`, options: varOpts })
  if (!key) return config

  const name = variantName(agent, key, agentEntry.variants[key] as VariantConfig)
  const confirmed = await showConfirm(api.ui, {
    title: "Delete variant?",
    message: `Permanently remove "${name}"?`,
  })
  if (!confirmed) return config

  const next = structuredClone(config)
  const entry = next.agents[agent] as AgentEntry
  delete entry.variants[key]

  markRestart(settings, `${name}: deleted variant requires restart to disappear from the task list.`)
  await warnRestartField(api, "Variant deleted", `"${name}" may remain visible until restart, but calls will be blocked by the server plugin.`)
  return next
}

async function previewConfig(api: TuiPluginApi, config: SidecarConfig): Promise<void> {
  const lines: string[] = []
  lines.push("=".repeat(50))
  lines.push("  Agent Variants Configuration Preview")
  lines.push("=".repeat(50))
  lines.push("")
  lines.push(`Debug mode: ${config.debug ? "enabled" : "disabled"}`)
  lines.push(`Prompt route markers: ${config.routing.prompt_markers ? "enabled" : "disabled"}`)

  if (Object.keys(config.models).length > 0) {
    lines.push("")
    lines.push("Named models:")
    for (const [key, raw] of Object.entries(config.models)) {
      const entry = raw as ModelEntry
      lines.push(`  ${key}: ${modelPresetDescription(entry)}${entry.label ? `  (${entry.label})` : ""}`)
    }
  }

  if (Object.keys(config.agents).length === 0) {
    lines.push("")
    lines.push("  (no agents configured)")
  }

  for (const [agent, raw] of agentEntries(config)) {
    const entry = raw as AgentEntry
    lines.push("")
    const status = entry.disable ? " [DISABLED]" : ""
    lines.push(`  Agent: ${agent}${status}`)

    if (hasOverrides(entry.parent as Record<string, unknown>)) {
      lines.push("    Parent overrides:")
      for (const field of EDITABLE_FIELDS) {
        const val = (entry.parent as Record<string, unknown>)[field.key]
        if (val !== undefined) lines.push(`      ${field.label}: ${truncate(JSON.stringify(val), 50)}`)
      }
    }

    const varKeys = Object.keys(entry.variants)
    if (varKeys.length > 0) {
      lines.push(`    Variants (${varKeys.length}):`)
      for (const [key, rawVar] of variantEntries(entry)) {
        const v = rawVar as VariantConfig
        const vStatus = v.disable ? " [DISABLED]" : ""
        lines.push(`      ${variantName(agent, key, v)}  (key: ${key})${vStatus}`)
        if (v.model) lines.push(`        model: ${modelDescription(v.model, config)}`)
        if (v.temperature !== undefined) lines.push(`        temperature: ${v.temperature}`)
        if (v.top_p !== undefined) lines.push(`        top_p: ${v.top_p}`)
        if (v.color) lines.push(`        color: ${v.color}`)
        if (v.prompt) lines.push(`        prompt: ${truncate(v.prompt, 40)}`)
        if (v.prompt_prepend) lines.push(`        prompt_prepend: ${truncate(v.prompt_prepend, 40)}`)
        if (v.prompt_append) lines.push(`        prompt_append: ${truncate(v.prompt_append, 40)}`)
      }
    }
  }

  lines.push("")
  lines.push(`  File: ${defaultSidecarPath()}`)
  lines.push("=".repeat(50))

  await showInfo(api, { title: "Configuration Preview", message: lines.join("\n") })
}

async function toggleDebug(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const next = structuredClone(config)
  next.debug = !next.debug
  try {
    saveSidecar(next, defaultSidecarPath(), { backup: false })
  } catch (err) {
    await showAlert(api.ui, { title: "Save failed", message: String(err instanceof Error ? err.message : err) })
    return config
  }
  api.ui.toast({
    variant: "info",
    title: `Debug mode ${next.debug ? "enabled" : "disabled"}`,
    message: next.debug
      ? "Variant routing debug toasts are enabled immediately."
      : "Variant routing debug toasts are disabled immediately.",
  })
  return next
}

async function togglePromptMarkers(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const next = structuredClone(config)
  next.routing = { ...next.routing, prompt_markers: !next.routing.prompt_markers }
  try {
    saveSidecar(next, defaultSidecarPath(), { backup: false })
  } catch (err) {
    await showAlert(api.ui, { title: "Save failed", message: String(err instanceof Error ? err.message : err) })
    return config
  }
  api.ui.toast({
    variant: next.routing.prompt_markers ? "warning" : "success",
    title: `Prompt route markers ${next.routing.prompt_markers ? "enabled" : "disabled"}`,
    message: next.routing.prompt_markers
      ? "Legacy prompt-marker routing is enabled immediately for future variant calls."
      : "Markerless metadata routing is enabled immediately for future variant calls.",
  })
  return next
}

async function updateUiSettings(api: TuiPluginApi, config: SidecarConfig, ui: Partial<SidecarConfig["ui"]>): Promise<SidecarConfig> {
  const next = structuredClone(config)
  next.ui = { ...next.ui, ...ui }
  setWizardDialogSize(api, next.ui.width)
  setWizardDialogHeight(api, next.ui.height)
  setWizardDialogHeightPercent(api, effectiveUiHeightPercent(next.ui))
  try {
    saveSidecar(next, defaultSidecarPath(), { backup: false })
  } catch (err) {
    await showAlert(api.ui, { title: "Save failed", message: String(err instanceof Error ? err.message : err) })
    setWizardDialogSize(api, config.ui.width)
    setWizardDialogHeight(api, config.ui.height)
    setWizardDialogHeightPercent(api, effectiveUiHeightPercent(config.ui))
    return config
  }
  api.ui.toast({
    variant: "info",
    title: "Wizard UI updated",
    message: `Width ${next.ui.width}, height ${effectiveUiHeightPercent(next.ui)}%.`,
  })
  return next
}

async function runDiagnostics(api: TuiPluginApi, config: SidecarConfig): Promise<void> {
  const generatedAliases = generatedAliasSet(config)
  const diagnostics = diagnoseConfig(config, {
    agents: agentsFromState(api).filter((agent) => !generatedAliases.has(agent)),
    providers: api.state.provider,
    pluginEntries: api.state.config.plugin as unknown[] | undefined,
    agentModes: agentModes(api),
  })
  const errors = diagnostics.filter((item) => item.level === "error").length
  const warnings = diagnostics.filter((item) => item.level === "warning").length
  const infos = diagnostics.filter((item) => item.level === "info").length
  const lines = [
    "Agent Variants Diagnostics",
    "=".repeat(50),
    `Sidecar: ${defaultSidecarPath()}`,
    `Agents configured: ${Object.keys(config.agents).length}`,
    `Variants configured: ${variantCount(config)}`,
    `Debug mode: ${config.debug ? "enabled" : "disabled"}`,
    `Prompt route markers: ${config.routing.prompt_markers ? "enabled" : "disabled"}`,
    `Debug log: ${debugLogPath(defaultConfigDir())}`,
    `Summary: ${errors} error(s), ${warnings} warning(s), ${infos} info`,
    "",
    ...(diagnostics.length === 0 ? ["No diagnostics."] : diagnostics.map((item) => `${item.level.toUpperCase()}: ${item.message}`)),
  ]
  api.ui.toast({
    variant: errors > 0 ? "error" : warnings > 0 ? "warning" : "success",
    title: "Agent Variants diagnostics",
    message: `${errors} error(s), ${warnings} warning(s)`,
  })
  await showInfo(api, { title: "Diagnostics", message: lines.join("\n") })
}

async function viewDebugLog(api: TuiPluginApi): Promise<void> {
  const file = debugLogPath(defaultConfigDir())
  if (!existsSync(file)) {
    await showInfo(api, { title: "Debug log", message: `No debug log found at ${file}` })
    return
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
  await showInfo(api, {
    title: "Debug log",
    message: [`File: ${file}`, "", ...lines.slice(-80)].join("\n"),
  })
}

async function clearDebugLog(api: TuiPluginApi): Promise<void> {
  const file = debugLogPath(defaultConfigDir())
  const confirmed = await showConfirm(api.ui, { title: "Clear debug log?", message: `Empty ${file}?` })
  if (!confirmed) return
  writeFileSync(file, "")
  api.ui.toast({ variant: "success", title: "Debug log cleared", message: file })
}

async function configBackupsMenu(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const journal = loadBackupJournal()
  const action = await showMenu(api, {
    title: "Config backups",
    options: [
      { title: "Browse backups", value: "browse", description: `${journal.patches.length} patch restore point(s), ${journal.full.length} full backup(s)` },
      { title: "Create full backup", value: "create", description: "Snapshot the current sidecar config now" },
      { title: "Delete all full backups", value: "delete-full", description: `${journal.full.length} full backup(s), patches are untouched`, danger: journal.full.length > 0 },
      { title: "< Back", value: "__back__", description: "Return to Debug & advanced" },
    ],
  })
  if (!action || action === "__back__") return config
  if (action === "create") {
    createFullBackup(loadSidecar(defaultSidecarPath()), { label: "Manual backup" })
    api.ui.toast({ variant: "success", title: "Full backup created", message: backupJournalPath(defaultConfigDir()) })
    return configBackupsMenu(api, config)
  }
  if (action === "delete-full") {
    if (journal.full.length === 0) return configBackupsMenu(api, config)
    const confirmed = await showConfirm(api.ui, { title: "Delete all full backups?", message: "This removes full snapshots only. Patch restore points are kept." })
    if (confirmed) {
      deleteAllFullBackups()
      api.ui.toast({ variant: "warning", title: "Full backups deleted", message: "All full snapshots were removed." })
    }
    return configBackupsMenu(api, config)
  }
  return browseConfigBackups(api, config)
}

async function browseConfigBackups(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const journal = loadBackupJournal()
  const items = backupListItems(config, journal)
  if (items.length === 0) {
    await showInfo(api, { title: "Config backups", message: `No backups found.\n\nJournal: ${backupJournalPath(defaultConfigDir())}` })
    return configBackupsMenu(api, config)
  }
  const choice = await showBackupList(api, items)
  if (!choice) return configBackupsMenu(api, config)
  if (choice.action === "delete" && choice.item.kind === "full") {
    deleteFullBackup(choice.item.id)
    api.ui.toast({ variant: "warning", title: "Full backup deleted", message: choice.item.title })
    return browseConfigBackups(api, config)
  }
  if (choice.action !== "select") return browseConfigBackups(api, config)
  const restored = choice.item.kind === "patch"
    ? reconstructPatchBackup(choice.item.index, loadSidecar(defaultSidecarPath()), journal)
    : { ok: true as const, config: choice.item.entry.config }
  if (!restored.ok) {
    await showAlert(api.ui, { title: "Backup chain invalid", message: restored.message })
    return browseConfigBackups(api, config)
  }
  await showInfo(api, { title: choice.item.title, message: backupPreview(choice.item, restored.config) })
  const shouldRestore = await showConfirm(api.ui, { title: "Restore this backup?", message: "This writes agent-variants.jsonc to the previewed state." })
  if (!shouldRestore) return browseConfigBackups(api, config)
  const hardBackup = await showConfirm(api.ui, { title: "Create full backup first?", message: "Optional safety snapshot of the current config before restoring. Default is No." })
  if (hardBackup) createFullBackup(loadSidecar(defaultSidecarPath()), { label: "Before restore" })
  if (choice.item.kind === "patch") {
    const latest = loadBackupJournal()
    const result = reconstructPatchBackup(choice.item.index, loadSidecar(defaultSidecarPath()), latest)
    if (!result.ok) {
      await showAlert(api.ui, { title: "Restore failed", message: result.message })
      return browseConfigBackups(api, config)
    }
    saveSidecar(result.config, defaultSidecarPath(), { backup: false })
    latest.patches = latest.patches.slice(result.consumed)
    saveBackupJournal(latest)
    api.ui.toast({ variant: "success", title: "Config restored", message: `${choice.item.title}; consumed patches were removed.` })
    return result.config
  }
  const latest = loadBackupJournal()
  saveSidecar(restored.config, defaultSidecarPath(), { backup: false })
  latest.patches = []
  saveBackupJournal(latest)
  api.ui.toast({ variant: "success", title: "Full backup restored", message: "Patch restore chain was reset for the restored state." })
  return restored.config
}

function backupListItems(config: SidecarConfig, journal: BackupJournal): BackupListItem[] {
  return [
    ...journal.patches.map((entry, index): BackupListItem => {
      const restored = reconstructPatchBackup(index, config, journal)
      return {
        kind: "patch",
        index,
        valid: restored.ok,
        title: `Patch ${index + 1} ${formatBackupTime(entry.timestamp)}`,
        description: restored.ok ? entry.changed_paths.slice(0, 3).join(", ") || "config change" : "invalid hash chain",
      }
    }),
    ...journal.full.map((entry): BackupListItem => ({
      kind: "full",
      id: entry.id,
      title: `Full ${formatBackupTime(entry.timestamp)}`,
      description: entry.label ?? entry.hash.slice(0, 8),
      entry,
    })),
  ]
}

function backupPreview(item: BackupListItem, config: SidecarConfig) {
  return [
    item.title,
    item.description,
    "",
    JSON.stringify(config, null, 2),
  ].join("\n")
}

function formatBackupTime(timestamp: string) {
  return timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z")
}

export function wizardInfoText(): string {
  return [
    "Hot Reload",
    "Hot reload applies to existing variant aliases only. Model, model variant, temperature, top_p, options, and prompt fields apply on the next matching variant call.",
    "",
    "Restart Required",
    "Restart-required changes affect OpenCode's cached task list or UI metadata: add/delete/disable, display name, description fields, and color.",
    "Red fields/options need restarting before the task list or UI fully reflects them.",
    "",
    "Model Presets",
    "Model presets appear in Model pickers. They can apply model, model variant, temperature, top_p, and options; local parent/variant fields override preset fields.",
    "",
    "Inheritance",
    "Parent propagation is off per field by default. Variant inheritance is on per field by default. A variant receives a parent field only when the parent propagates it, the variant accepts it, and the variant has no local value.",
    "",
    "Built-in Routing",
    "Built-in variants route through their native parent agent, so the footer may show the parent. Runtime route details stay internal; model-visible task history is repaired back to the selected alias.",
    "Markerless metadata routing is the default. The legacy prompt-marker path is available only as an advanced debug fallback.",
    "",
    "Editing",
    "Submit an empty value while editing a field to remove that local override. Escape cancels without changes.",
  ].join("\n")
}

async function showWizardInfo(api: TuiPluginApi): Promise<void> {
  await showInfo(api, {
    title: "Agent Variants Info",
    message: wizardInfoText(),
  })
}

async function saveConfig(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<void> {
  try {
    saveSidecar(config, defaultSidecarPath())
    const reasons = uniqueReasons(settings)
    const message = reasons.length > 0
      ? [
          "Saved with restart-required changes.",
          "",
          ...reasons.map((reason) => `- ${reason}`),
          "",
          settings.hotChanges ? "Hot-reloadable runtime fields still apply on the next matching variant call." : "Restart OpenCode before relying on the changed task list/UI.",
        ].join("\n")
      : settings.hotChanges
        ? "Saved. Runtime changes apply on the next matching variant call; no restart-required changes were recorded."
        : "Saved. No changes requiring restart were recorded."
    await showInfo(api, { title: reasons.length > 0 ? "Restart Required" : "Saved", message })
    api.ui.toast({
      variant: reasons.length > 0 ? "warning" : "success",
      title: "Saved",
      message: reasons.length > 0 ? "Restart OpenCode to apply task-list/UI changes." : "Runtime changes apply on the next matching variant call.",
    })
  } catch (err) {
    await showAlert(api.ui, {
      title: "Save failed",
      message: String(err instanceof Error ? err.message : err),
    })
  }
}

// Field prompting.

function renderedSelectionPresetText(config: SidecarConfig, agent: string, key: string, variant: VariantConfig, presetKey: string) {
  const preset = SELECTION_PRESETS.find((item) => item.key === presetKey)
  if (!preset) return ""
  return renderTemplate(preset.text, templateContext(agent, key, variant, config))
}

function selectionPresetHelp(config: SidecarConfig, agent: string, key: string, variant: VariantConfig, presetKey: string) {
  const preset = SELECTION_PRESETS.find((item) => item.key === presetKey)
  if (!preset) return "No preset details available."
  return [
    preset.title,
    "",
    preset.summary,
    "",
    "Preset guidance text:",
    renderedSelectionPresetText(config, agent, key, variant, preset.key),
    "",
    "Materialized Description value:",
    generatedVariantBase(agent, key, variant, config, preset.key),
  ].join("\n")
}

function selectionPresetOptions(config: SidecarConfig, agent: string, key: string, variant: VariantConfig, includeAuto = true): WizardSelectOption<string>[] {
  const inferred = inferredSelectionPreset(agent, key, variant, config)
  const options: WizardSelectOption<string>[] = []
  if (includeAuto) {
    options.push({
      title: inferred ? `Auto: ${inferred.title}` : "Auto: generic variant guidance",
      value: "__auto__",
      description: inferred ? inferred.summary : "No keyword match; use generic exact-alias guidance",
      help: inferred
        ? ["Automatic preset selection", "", `The wizard inferred ${inferred.title} from the variant key/name/model/model variant. Choosing Auto removes any local Description override and lets the built-in generator keep inferring.`, "", selectionPresetHelp(config, agent, key, variant, inferred.key)].join("\n")
        : "Automatic preset selection did not find a variant-intent keyword. Choosing Auto removes any local Description override and keeps generic exact-alias guidance.",
    })
  }
  for (const preset of SELECTION_PRESETS) {
    options.push({
      title: preset.title,
      value: preset.key,
      description: preset.summary,
      help: selectionPresetHelp(config, agent, key, variant, preset.key),
    })
  }
  return options
}

async function pickSelectionPreset(api: TuiPluginApi, config: SidecarConfig, agent: string, key: string, variant: VariantConfig, includeAuto = true) {
  const picked = await showMenu(api, {
    title: `Description guidance - ${variantName(agent, key, variant)}`,
    options: [...selectionPresetOptions(config, agent, key, variant, includeAuto), { title: "< Back", value: "__back__", description: "Keep current description behavior" }],
    current: inferredSelectionPreset(agent, key, variant, config)?.key ?? "__auto__",
  })
  if (!picked || picked === "__back__") return undefined
  return picked
}

async function promptForField(
  api: TuiPluginApi,
  field: string,
  current: string | undefined,
  context?: { config: SidecarConfig; model: unknown; includeModelPresets?: boolean; descriptionVariant?: { agent: string; key: string; variant: VariantConfig } },
): Promise<unknown> {
  if (field === "model") {
    const config = context?.config ?? loadSidecar(defaultSidecarPath())
    const models = modelOptions(api, config, { includePresets: context?.includeModelPresets })
    models.unshift({ title: "< Remove value >", value: "__remove__", description: "Delete this local model override", category: "Current field" })
    const picked = await showSelect(api.ui, { title: "Select model", options: models, current })
    if (!picked) return undefined
    if (picked === "__remove__") return ""
    if (picked === "__custom__") {
      return showPrompt(api.ui, { title: "Custom model ID", placeholder: "provider/model-id", value: current })
    }
    return picked
  }

  if (field === "variant") {
    const config = context?.config ?? loadSidecar(defaultSidecarPath())
    const resolved = resolveModelReference(api, config, context?.model)
    if (!resolved || resolved.variants.length === 0) {
      api.ui.toast({
        variant: "info",
        title: "No known variants",
        message: resolved ? `${resolved.modelName} exposes no known variants.` : "Pick a concrete model first for known variants.",
      })
    }
    const picked = await showSelect(api.ui, { title: "Select model variant", options: modelVariantOptions(api, config, context?.model), current })
    if (!picked) return undefined
    if (picked === "__remove__") return ""
    if (picked === "__custom__") {
      return showPrompt(api.ui, { title: "Custom model variant", placeholder: "variant-id", value: current })
    }
    return picked
  }

  if (field === "color") {
    const picked = await showMenu(api, { title: "Pick color", options: [{ title: "Default", value: "__remove__", description: "Delete this local color override" }, ...colorOptions(api)] })
    if (picked === "__custom__") {
      return showPrompt(api.ui, { title: "Hex color", placeholder: "#FF5733", value: current })
    }
    if (picked === "__remove__") return ""
    return picked
  }

  if (field === "options") {
    const val = await showPrompt(api.ui, {
      title: "Options (JSON object)",
      placeholder: current ?? '{"key": "value"}',
      value: current ?? undefined,
    })
    if (val === undefined) return undefined
    if (val === "") return ""
    try {
      return JSON.parse(val) as Record<string, unknown>
    } catch {
      await showAlert(api.ui, { title: "Invalid JSON", message: "Please enter a valid JSON object." })
      return undefined
    }
  }

  if (field === "description" && context?.descriptionVariant) {
    const { agent, key, variant } = context.descriptionVariant
    while (true) {
      const val = await showDescriptionPrompt(api, {
        title: "Description (replace)",
        value: current,
      })
      if (val === "__preset__") {
        const preset = await pickSelectionPreset(api, context.config, agent, key, variant, true)
        if (!preset) continue
        if (preset === "__auto__") return ""
        return generatedVariantBase(agent, key, variant, context.config, preset)
      }
      return val
    }
  }

  if (field === "temperature" || field === "top_p") {
    const label = field === "top_p" ? "Top P" : "Temperature"
    const val = await showPrompt(api.ui, {
      title: label,
      placeholder: "0.0 - 2.0",
      value: current ?? undefined,
    })
    if (val === undefined) return undefined
    if (val === "") return ""
    const num = Number(val)
    if (isNaN(num)) {
      await showAlert(api.ui, { title: "Invalid number", message: `"${val}" is not a valid number.` })
      return undefined
    }
    return num
  }

  return showPrompt(api.ui, {
    title: field.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
    value: current,
  })
}

// Utility.

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "..."
}

function modelDescription(model: string | undefined, config: SidecarConfig): string {
  if (!model) return "(inherit)"
  const named = config.models[model] as ModelEntry | undefined
  if (named) return `${model} -> ${named.model}`
  return model
}

function hasOverrides(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0
}

function formatInputValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

// Main menu loop.

export async function mainMenu(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings, host?: WizardHost): Promise<SidecarConfig> {
  const agentCount = Object.keys(config.agents).length
  const vCount = variantCount(config)

  const opts: WizardSelectOption<string>[] = [
    { title: "Add variant", value: "add", description: "Create a new agent variant", danger: true, help: "Creates a new variant under a parent subagent. New task-list aliases require restart before they appear." },
    { title: "Model presets", value: "models", description: `${Object.keys(config.models).length} shortcut(s)`, help: "Create reusable model shortcuts like light or heavy. Presets appear in Model pickers and can include model, model variant, temperature, top_p, and options." },
    { title: "Edit parent fields", value: "edit-parent", description: "Override fields on an agent parent", help: "Parent fields can be propagated per field to variants. Red fields change cached task-list/UI metadata and require restart." },
    { title: "Edit variant", value: "edit-variant", description: "Change fields on an existing variant", help: "Variant fields override inherited parent values. Red fields require restart before OpenCode's task list/UI reflects them." },
    { title: "Toggle disable", value: "toggle", description: "Enable or disable agents/variants", danger: true, help: "Disable keeps config without deleting it. Task-list visibility updates after restart, and stale calls are blocked at runtime." },
    { title: "Delete variant", value: "delete", description: "Remove a variant", danger: true, help: "Deletes a variant from the sidecar. Restart OpenCode to remove it from the cached task list." },
    { title: "Info", value: "info", description: "Hot reload, restart boundaries, inheritance, and routing behavior", help: "Shows a quick guide. Red options or fields require restarting OpenCode to fully apply." },
    { title: "Run diagnostics", value: "diagnostics", description: "Check models, conflicts, plugin install, and task-callability", help: "Validates model references, alias conflicts, plugin install state, and parent subagent compatibility." },
    { title: "Debug & advanced", value: "advanced", description: "Debug mode, logs, UI size, and filters", help: "Advanced tools for routing diagnostics, wizard sizing, and wizard-local filtering." },
    { title: "Preview configuration", value: "preview", description: `View current config (${agentCount} agents, ${vCount} variants)`, help: "Shows the current sidecar config summary before saving." },
    { title: "Save & exit", value: "save", description: "Write to disk with backup", help: "Saves agent-variants.jsonc. Runtime fields hot-reload; red task-list/UI fields require restart." },
  ]

  const action = await showMenu(api, {
    title: "Agent Variants",
    options: opts,
  })

  switch (action) {
    case "add":
      return mainMenu(api, await addVariant(api, config, settings), settings)
    case "models":
      return mainMenu(api, await manageModelPresets(api, config), settings)
    case "edit-parent":
      return editParentFlow(api, config, settings)
    case "edit-variant":
      return mainMenu(api, await editVariant(api, config, settings), settings)
    case "toggle":
      return mainMenu(api, await toggleDisable(api, config, settings), settings)
    case "info":
      await showWizardInfo(api)
      return mainMenu(api, config, settings)
    case "diagnostics":
      await runDiagnostics(api, config)
      return mainMenu(api, config, settings)
    case "advanced":
      return mainMenu(api, await debugAdvancedMenu(api, config, settings), settings)
    case "delete":
      return mainMenu(api, await deleteVariant(api, config, settings), settings)
    case "preview":
      await previewConfig(api, config)
      return mainMenu(api, config, settings)
    case "save":
      if (host?.onSave) {
        const action = await host.onSave(config, settings)
        if (action === "continue") return mainMenu(api, config, settings, host)
        return config
      }
      await saveConfig(api, config, settings)
      return config
    default:
      return config
  }
}

async function editParentFlow(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
  const agents = selectableParentAgents(api, config, settings)
  const opts: WizardSelectOption<string>[] = agents.map((a) => {
    const entry = config.agents[a] as AgentEntry | undefined
    const overrides = entry ? Object.keys(entry.parent).length : 0
    return {
      title: a,
      value: a,
      description: `${agentMode(api, a)} - ${overrides > 0 ? `${overrides} parent override(s)` : "No overrides"}`,
      color: parentColor(api, config, a),
    }
  })
  opts.push({
    title: "< Back",
    value: "__back__",
    description: "Return to main menu",
  })

  const agent = await showMenu(api, { title: "Edit parent fields - pick agent", options: opts })
  if (!agent || agent === "__back__") return mainMenu(api, config, settings)

  const updated = await editParentFields(api, config, agent, settings)
  return mainMenu(api, updated, settings)
}

async function debugAdvancedMenu(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
  const opts: WizardSelectOption<string>[] = [
    {
      title: `Debug mode: ${config.debug ? "on" : "off"}`,
      value: "debug",
      description: "Toggle routing/model diagnostic toasts immediately",
    },
    {
      title: `Prompt route markers: ${config.routing.prompt_markers ? "on" : "off"}`,
      value: "prompt-markers",
      description: config.routing.prompt_markers ? "Legacy prompt-marker correlation is active" : "Default markerless metadata correlation is active",
      danger: config.routing.prompt_markers,
      help: "Default off. Markerless routing matches the child session through OpenCode's task metadata and avoids putting random route tokens in prompts. Enable only as a legacy debug fallback if markerless routing fails.",
    },
    { title: "View debug log", value: "view-log", description: "Show recent agent-variants.debug.log entries" },
    { title: "Clear debug log", value: "clear-log", description: "Empty agent-variants.debug.log" },
    { title: "Config backups", value: "backups", description: "Preview, restore, and snapshot sidecar config" },
    {
      title: `Wizard UI width: ${wizardDialogSize(api)}`,
      value: "ui-size",
      description: "Cycle dialog width: medium, large, xlarge",
      help: "Controls the width of Agent Variants custom wizard screens. OpenCode currently exposes fixed widths only: medium = 60 columns, large = 88 columns, xlarge = 116 columns.",
    },
    {
      title: `Wizard UI height: ${wizardDialogHeightPercent(api)}%`,
      value: "ui-height",
      description: "Adjust max height with slider or preset reference points",
      help: `Controls the maximum height of Agent Variants custom wizard screens. Presets: ${HEIGHT_PRESETS.map((preset) => `${preset.label}=${preset.value}%`).join(", ")}. Short menus stay compact; long info screens can use the extra space.`,
    },
    {
      title: `Parent picker filter: ${settings.subagentCapableOnly ? "subagent-capable only" : "all agents"}`,
      value: "filter",
      description: "Wizard-only filter for adding/editing parent entries",
    },
    { title: "< Back", value: "__back__", description: "Return to main menu" },
  ]

  const action = await showMenu(api, { title: "Debug & advanced", options: opts })
  switch (action) {
    case "debug":
      return debugAdvancedMenu(api, await toggleDebug(api, config), settings)
    case "prompt-markers":
      return debugAdvancedMenu(api, await togglePromptMarkers(api, config), settings)
    case "view-log":
      await viewDebugLog(api)
      return debugAdvancedMenu(api, config, settings)
    case "clear-log":
      await clearDebugLog(api)
      return debugAdvancedMenu(api, config, settings)
    case "backups":
      return debugAdvancedMenu(api, await configBackupsMenu(api, config), settings)
    case "ui-size":
      return debugAdvancedMenu(api, await updateUiSettings(api, config, { width: nextWizardDialogSize(api) }), settings)
    case "ui-height": {
      const height = await showHeightSlider(api, config)
      if (height === undefined) return debugAdvancedMenu(api, config, settings)
      return debugAdvancedMenu(api, await updateUiSettings(api, config, { height_percent: height }), settings)
    }
    case "filter":
      settings.subagentCapableOnly = !settings.subagentCapableOnly
      api.ui.toast({
        variant: "info",
        title: "Parent filter updated",
        message: settings.subagentCapableOnly ? "Showing subagent-capable parents only." : "Showing all parent agents.",
      })
      return debugAdvancedMenu(api, config, settings)
    default:
      return config
  }
}

// ---------------------------------------------------------------------------
// Embedded-host entry points (Config Studio integration)
// ---------------------------------------------------------------------------

/** Shared parent-agent picker used by the flows below and by embedded hosts. */
export async function pickParentAgent(
  api: TuiPluginApi,
  config: SidecarConfig,
  settings: WizardSettings,
  title: string,
): Promise<string | undefined> {
  const agents = selectableParentAgents(api, config, settings)
  if (agents.length === 0) {
    await showAlert(api.ui, {
      title: "No agents",
      message: settings.subagentCapableOnly
        ? "No subagent-capable agents are available. Open Debug & advanced and disable the parent filter only if you need to inspect or repair existing config."
        : "No agents available.",
    })
    return undefined
  }
  const agentOpts: WizardSelectOption<string>[] = agents.map((a) => ({
    title: a,
    value: a,
    description: `${agentMode(api, a)} - ${BUILTIN_AGENT_DESCRIPTIONS[a] ?? api.state.config.agent?.[a]?.description ?? "Configured agent"}`,
    color: parentColor(api, config, a),
  }))
  return await showMenu(api, { title, options: agentOpts })
}

/** Pre-scoped add-variant flow (skips the agent picker). */
export async function addVariantFor(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings, agent: string): Promise<SidecarConfig> {
  if (settings.subagentCapableOnly && !isSubagentCapableMode(agentMode(api, agent))) {
    await showAlert(api.ui, {
      title: "Primary-only agent",
      message: `"${agent}" is primary-only and cannot be used by the task tool. Agent Variants are intended for subagents.`,
    })
    api.ui.toast({ variant: "warning", title: "Variant not added", message: `${agent} is primary-only.` })
    return config
  }

  const existingKeys = Object.keys(config.agents[agent]?.variants ?? {})
  const defaultKey = existingKeys.length === 0 ? "light" : undefined
  const key = await showPrompt(api.ui, {
    title: `Variant key for "${agent}"`,
    description: `This becomes the alias name (e.g. "${agent}-<key>"). Must be unique per agent.`,
    placeholder: defaultKey ?? "variant-key",
    value: defaultKey,
  })
  if (!key) return config
  if (existingKeys.includes(key)) {
    await showAlert(api.ui, { title: "Duplicate key", message: `"${key}" already exists for "${agent}".` })
    return config
  }

  const next = structuredClone(config)
  if (!next.agents[agent]) {
    next.agents[agent] = { parent: {}, variants: {} }
  }

  const variant = await editVariantFields(api, next, {}, agent, key)
  next.agents[agent].variants[key] = variant

  const name = variantName(agent, key, variant)
  markRestart(settings, `${name}: added variant requires restart before it appears in the task list.`)
  await warnRestartField(api, "Variant added", "New variants are added to OpenCode's cached task list only at startup.")
  return next
}

/** Pre-scoped edit-variant flow: opens the field editor for one variant. */
export async function editVariantFor(
  api: TuiPluginApi,
  config: SidecarConfig,
  settings: WizardSettings,
  agent: string,
  key: string,
): Promise<SidecarConfig> {
  const entry = config.agents[agent] as AgentEntry | undefined
  const variant = entry?.variants[key] as (VariantConfig & Record<string, unknown>) | undefined
  if (!entry || !variant) {
    await showAlert(api.ui, { title: "Unknown variant", message: `Variant "${key}" does not exist for "${agent}".` })
    return config
  }

  const next = structuredClone(config)
  let selectedField: string | undefined = EDITABLE_FIELDS[0]?.key
  while (true) {
    const nextEntry = next.agents[agent] as AgentEntry
    const parent = nextEntry.parent
    const target = nextEntry.variants[key] as VariantConfig & Record<string, unknown>
    const fieldOpts: FieldListOption[] = [
      ...EDITABLE_FIELDS.map((field) => fieldListOption(api, next, { field, parent, variant: target, mode: "variant", parentName: agent, variantKey: key, alias: variantName(agent, key, target) })),
      {
        title: "Display name",
        value: "name",
        description: target.name ? String(target.name) : `default: ${agent}-${key}`,
        restart: true,
      },
      { title: "< Back", value: "__back__", description: "Return", kind: "action" },
    ]

    const pickedField = await showFieldList(api, { title: `Edit field - ${variantName(agent, key, target)}`, options: fieldOpts, current: selectedField, titleColor: variantColor(api, next, agent, key, target) })
    const field = pickedField?.value
    if (!field || field === "__back__") return next
    selectedField = field

    if (field === "name") {
      if (pickedField.action === "inspect") {
        await showInfo(api, { title: "Display name", message: inspectVariantName(agent, key, target) })
        continue
      }
      const val = await showPrompt(api.ui, { title: "Display name", value: target.name as string | undefined, placeholder: `${agent}-${key}` })
      if (val === undefined) continue
      const previous = target.name
      if (!fieldValueChanged(previous, val)) continue
      if (val === "") delete target.name
      if (val !== "") target.name = val
      markRestart(settings, `${agent}.${key}: display name requires restart.`)
      await warnRestartField(api, "Display name", "Generated agent names are cached by OpenCode's task list.")
      continue
    }

    if (!EDITABLE_FIELD_KEYS.has(field as PatchField)) continue
    const picked = fieldDef(field)
    if (!picked) continue
    if (pickedField.action === "inspect") {
      await showInfo(api, { title: picked.label, message: inspectVariantField(api, next, agent, key, nextEntry.parent, target, picked.key) })
      continue
    }
    if (pickedField.action === "toggle") {
      target.inherit = { ...(target.inherit ?? {}), [picked.key]: !inheritanceEnabled(target, picked.key) }
      markFieldChange(settings, picked.key, `${variantName(agent, key, target)}: ${picked.label} inheritance requires restart.`)
      if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "Inheritance for this field affects cached task-list/UI metadata.")
      continue
    }
    const val = await promptForField(api, field, formatInputValue(target[picked.key]), {
      config: next,
      model: effectiveVariantPatch(nextEntry.parent, target).model,
      descriptionVariant: { agent, key, variant: target },
    })
    if (val === undefined) continue
    const previous = target[picked.key]
    if (!fieldValueChanged(previous, val)) continue
    setField(target, picked.key, val)
    if (picked.key === "model" && previous !== val) delete target.variant
    markFieldChange(settings, picked.key, `${variantName(agent, key, target)}: ${picked.label} requires restart.`)
    if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "This field is stored in OpenCode's cached agent/task-list metadata.")
  }
}

/** Pre-scoped toggle for one parent or one variant. */
export async function toggleEntryFor(
  api: TuiPluginApi,
  config: SidecarConfig,
  settings: WizardSettings,
  target: { agent: string; variant?: string },
): Promise<SidecarConfig> {
  const next = structuredClone(config)
  if (!target.variant) {
    if (!next.agents[target.agent]) {
      next.agents[target.agent] = { parent: {}, variants: {} }
    }
    const entry = next.agents[target.agent] as AgentEntry
    entry.disable = !entry.disable
    const state = entry.disable ? "disabled" : "enabled"
    markRestart(settings, `${target.agent}: parent ${state} requires restart.`)
    await warnRestartField(api, "Parent disable", `Parent ${state}; restart OpenCode to update task-list visibility.`)
  } else {
    const entry = next.agents[target.agent] as AgentEntry | undefined
    const variant = entry?.variants[target.variant] as VariantConfig | undefined
    if (variant) {
      variant.disable = !variant.disable
      const state = variant.disable ? "disabled" : "enabled"
      markRestart(settings, `${variantName(target.agent, target.variant, variant)}: variant ${state} requires restart.`)
      await warnRestartField(api, "Variant disable", `Variant ${state}; restart OpenCode to update task-list visibility.`)
    }
  }
  return next
}

/** Pre-scoped delete-variant flow (asks for confirmation). */
export async function deleteVariantFor(
  api: TuiPluginApi,
  config: SidecarConfig,
  settings: WizardSettings,
  agent: string,
  key: string,
): Promise<SidecarConfig> {
  const entry = config.agents[agent] as AgentEntry | undefined
  const variant = entry?.variants[key] as VariantConfig | undefined
  if (!entry || !variant) {
    await showAlert(api.ui, { title: "Unknown variant", message: `Variant "${key}" does not exist for "${agent}".` })
    return config
  }
  const name = variantName(agent, key, variant)
  const confirmed = await showConfirm(api.ui, {
    title: "Delete variant?",
    message: `Permanently remove "${name}"?`,
  })
  if (!confirmed) return config

  const next = structuredClone(config)
  const nextEntry = next.agents[agent] as AgentEntry
  delete nextEntry.variants[key]

  markRestart(settings, `${name}: deleted variant requires restart to disappear from the task list.`)
  await warnRestartField(api, "Variant deleted", `"${name}" may remain visible until restart, but calls will be blocked by the server plugin.`)
  return next
}

