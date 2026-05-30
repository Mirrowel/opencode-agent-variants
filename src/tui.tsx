import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  BUILTIN_AGENT_DESCRIPTIONS,
  debugLogPath,
  defaultConfigDir,
  defaultSidecarPath,
  diagnoseConfig,
  effectiveVariantPatch,
  inheritanceEnabled,
  inheritedPatch,
  isHotReloadField,
  isSubagentCapableMode,
  loadSidecar,
  patchHasValue,
  propagationEnabled,
  saveSidecar,
  variantName,
  type AgentMode,
  type ModelShortcut,
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

type WizardSettings = {
  subagentCapableOnly: boolean
  hotChanges: boolean
  restartReasons: string[]
}

// Constants.

const BUILTIN_AGENT_KEYS = Object.keys(BUILTIN_AGENT_DESCRIPTIONS)
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
}

function variantColor(api: TuiPluginApi, config: SidecarConfig, agent: string, key: string, variant: VariantConfig): DisplayColor | undefined {
  return resolveUiColor(api, effectiveVariantPatch((config.agents[agent] as AgentEntry | undefined)?.parent ?? {}, variant).color)
}

function variantCount(config: SidecarConfig): number {
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

function fieldDefaultDescription(input: { field: PatchField; mode: "parent" | "variant"; parentName?: string; variantName?: string }) {
  if (input.field === "model") return "default: current/session model"
  if (input.field === "variant") return "default: provider default"
  if (input.field === "temperature") return "default: provider/model default"
  if (input.field === "top_p") return "default: provider/model default"
  if (input.field === "description") return input.mode === "variant" ? `default: Copy of ${input.parentName ?? "parent"} using model` : "default: OpenCode/native description"
  if (input.field === "color") return "default: OpenCode/default color"
  if (input.field === "options") return "default: no extra options"
  return "default: not set"
}

function fieldListOption(api: TuiPluginApi, input: { field: FieldDef; parent?: AgentEntry["parent"]; variant?: VariantConfig; mode: "parent" | "variant"; parentName?: string; alias?: string }): FieldListOption {
  const source = sourceLabel({ parent: input.parent, variant: input.variant, field: input.field.key, mode: input.mode })
  const value = fieldResult({ parent: input.parent, variant: input.variant, field: input.field.key, mode: input.mode })
  const inherited = source === "SRC:inherit"
  return {
    title: input.field.label,
    value: input.field.key,
    description: value !== undefined ? `${inherited ? "inherited: " : ""}${truncate(formatInputValue(value) ?? String(value), 76)}` : fieldDefaultDescription({ field: input.field.key, mode: input.mode, parentName: input.parentName, variantName: input.alias }),
    restart: !isHotReloadField(input.field.key),
    channel: true,
    channelLabel: input.mode === "parent" ? "propagation" : "inheritance",
    channelEnabled: input.mode === "parent"
      ? propagationEnabled(input.parent ?? {}, input.field.key)
      : inheritanceEnabled(input.variant ?? {}, input.field.key),
    previewColor: input.field.key === "color" ? resolveUiColor(api, value) : undefined,
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
  const popMode = props.api.mode.push("agent-variants.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) => setSelected((value) => Math.max(0, Math.min(props.options.length - 1, value + delta)))
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
      { name: `${commandPrefix}.up`, title: "Previous item", run: () => move(-1) },
      { name: `${commandPrefix}.down`, title: "Next item", run: () => move(1) },
      { name: `${commandPrefix}.select`, title: "Select item", run: choose },
      { name: `${commandPrefix}.inspect`, title: "Option help", run: inspect },
      { name: `${commandPrefix}.back`, title: "Back", run: () => props.onDone(undefined) },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select item" },
      { key: "i", cmd: `${commandPrefix}.inspect`, desc: "Option help" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
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
                <text width={30} flexShrink={0} fg={fg()} wrapMode="none"><b>{option.title}</b></text>
                <text flexGrow={1} fg={descFg()} wrapMode="none" overflow="hidden">{option.description ?? ""}</text>
              </box>
            )
          }}
        </For>
      </box>
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
  const popMode = props.api.mode.push("agent-variants.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) => {
    setSelected((value) => Math.max(0, Math.min(props.options.length - 1, value + delta)))
  }
  const choose = (action: FieldListChoice["action"] = "select") => {
    const option = current()
    if (!option) return
    if (action !== "select" && option.kind === "action") return
    if (action !== "select" && !option.channel) return
    props.onDone({ action, value: option.value })
  }
  const commandPrefix = `agent-variants.field-list.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous field", run: () => move(-1) },
      { name: `${commandPrefix}.down`, title: "Next field", run: () => move(1) },
      { name: `${commandPrefix}.select`, title: "Select field", run: () => choose("select") },
      { name: `${commandPrefix}.toggle`, title: "Toggle inheritance", run: () => choose("toggle") },
      { name: `${commandPrefix}.inspect`, title: "Field info/help", run: () => choose("inspect") },
      { name: `${commandPrefix}.back`, title: "Back", run: () => props.onDone(undefined) },
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

function InfoDialog(props: { api: TuiPluginApi; title: string; message: string; onDone: () => void }) {
  const theme = () => props.api.theme.current
  const popMode = props.api.mode.push("agent-variants.dialog")
  const lines = createMemo(() => props.message.split(/\r?\n/))
  const commandPrefix = `agent-variants.info.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [{ name: `${commandPrefix}.close`, title: "Close", run: props.onDone }],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.close`, desc: "Close" },
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
      <box flexDirection="column" gap={0} marginBottom={1}>
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
      <box flexDirection="row" justifyContent="flex-end" width="100%">
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

function inspectParentField(agent: string, parent: AgentEntry["parent"], field: PatchField) {
  const def = fieldDef(field)
  const value = parent[field]
  const help = FIELD_HELP[field]
  return [
    `${def?.label ?? field} (${agent} parent)`,
    "",
    help.purpose,
    "",
    help.parent,
    "",
    `Hot reload: ${isHotReloadField(field) ? "yes" : "no, restart required"}`,
    `Local value: ${value === undefined ? "not set" : formatInputValue(value)}`,
    `Propagates to variants: ${propagationEnabled(parent, field) ? "yes" : "no"}`,
    `Resulting parent value: ${value === undefined ? "not set" : formatInputValue(value)}`,
    "",
    help.empty,
    "Submitting an empty value in the editor removes the local override. Escape cancels without changes.",
  ].join("\n")
}

function inspectVariantField(agent: string, key: string, parent: AgentEntry["parent"], variant: VariantConfig, field: PatchField) {
  const def = fieldDef(field)
  const help = FIELD_HELP[field]
  const inherited = inheritedPatch(parent, variant)[field]
  const local = variant[field]
  const result = effectiveVariantPatch(parent, variant)[field]
  return [
    `${def?.label ?? field} (${variantName(agent, key, variant)})`,
    "",
    help.purpose,
    "",
    help.variant,
    "",
    `Hot reload: ${isHotReloadField(field) ? "yes" : "no, restart required"}`,
    `Local value: ${local === undefined ? "not set" : formatInputValue(local)}`,
    `Variant accepts inheritance: ${inheritanceEnabled(variant, field) ? "yes" : "no"}`,
    `Parent propagates this field: ${propagationEnabled(parent, field) ? "yes" : "no"}`,
    `Inherited value: ${inherited === undefined ? "not available" : formatInputValue(inherited)}`,
    `Resulting value: ${result === undefined ? "not set" : formatInputValue(result)}`,
    `Source: ${local !== undefined ? "local variant override" : inherited !== undefined ? "inherited parent override" : "none"}`,
    "",
    help.empty,
    "Submitting an empty value in the editor removes the local override. Escape cancels without changes.",
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

async function manageModelPresets(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
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
        help: modelPresetFieldHelp(field.key, key),
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
    if (picked === "model" && before !== value) delete preset.variant
  }
}

function modelPresetFieldHelp(field: keyof ModelShortcut, key: string) {
  const base = `Model preset "${key}".`
  if (field === "model") return `${base}\n\nRequired provider/model reference. This is what the preset selects when a parent or variant uses this shortcut in its Model field.`
  if (field === "label") return `${base}\n\nOptional human label shown in descriptions and pickers.`
  if (field === "variant") return `${base}\n\nOptional provider model variant, such as low, medium, high, or xhigh when the selected model exposes variants.`
  if (field === "temperature") return `${base}\n\nOptional temperature applied with the preset unless the parent or variant has a local Temperature override.`
  if (field === "top_p") return `${base}\n\nOptional top_p applied with the preset unless locally overridden.`
  return `${base}\n\nOptional provider/model request options JSON object applied with the preset.`
}

async function editParentFields(
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
      ...EDITABLE_FIELDS.map((field) => fieldListOption(api, { field, parent, mode: "parent", parentName: agent })),
      { title: "< Back", value: "__back__", description: "Return to main menu", kind: "action" },
    ]

    const pickedField = await showFieldList(api, { title: `Edit parent fields - ${agent}`, options: fieldOpts, current: selectedField, titleColor: parentColor(api, next, agent) })
    const field = pickedField?.value
    if (!field || field === "__back__") return next
    selectedField = field

    const picked = fieldDef(field)
    if (!picked) continue
    if (pickedField.action === "inspect") {
      await showInfo(api, { title: picked.label, message: inspectParentField(agent, parent, picked.key) })
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

    const value = await promptForField(api, field.key, formatInputValue(variant[field.key]), { config, model: variant.model })
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
      ...EDITABLE_FIELDS.map((field) => fieldListOption(api, { field, parent, variant: target, mode: "variant", parentName: agent, alias: variantName(agent, key, target) })),
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
      const val = await showPrompt(api.ui, { title: "Display name", value: target.name as string | undefined, placeholder: `${agent}-${key}` })
      if (val === undefined) continue
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
      await showInfo(api, { title: picked.label, message: inspectVariantField(agent, key, nextEntry.parent, target, picked.key) })
      continue
    }
    if (pickedField.action === "toggle") {
      target.inherit = { ...(target.inherit ?? {}), [picked.key]: !inheritanceEnabled(target, picked.key) }
      markFieldChange(settings, picked.key, `${variantName(agent, key, target)}: ${picked.label} inheritance requires restart.`)
      if (!isHotReloadField(picked.key)) await warnRestartField(api, picked.label, "Inheritance for this field affects cached task-list/UI metadata.")
      continue
    }
    const val = await promptForField(api, field, formatInputValue(target[picked.key]), { config: next, model: effectiveVariantPatch(nextEntry.parent, target).model })
    if (val === undefined) continue
    const previous = target[picked.key]
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
    saveSidecar(next, defaultSidecarPath())
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
    await showAlert(api.ui, { title: "Debug log", message: `No debug log found at ${file}` })
    return
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
  await showAlert(api.ui, {
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

async function showWizardInfo(api: TuiPluginApi): Promise<void> {
  await showInfo(api, {
    title: "Agent Variants Info",
    message: [
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
      "Built-in variants route through their native parent agent, so the footer may show the parent. Task output and expanded inputs show selected_alias/agent_variant, routed_agent, and effective_model.",
      "",
      "Editing",
      "Submit an empty value while editing a field to remove that local override. Escape cancels without changes.",
    ].join("\n"),
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
    await showAlert(api.ui, { title: reasons.length > 0 ? "Restart Required" : "Saved", message })
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

async function promptForField(
  api: TuiPluginApi,
  field: string,
  current: string | undefined,
  context?: { config: SidecarConfig; model: unknown; includeModelPresets?: boolean },
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

async function mainMenu(api: TuiPluginApi, config: SidecarConfig, settings: WizardSettings): Promise<SidecarConfig> {
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
    { title: "Debug & advanced", value: "advanced", description: "Debug mode, logs, and wizard-only parent filter", help: "Advanced tools for routing diagnostics and wizard-local filtering." },
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
  const opts: TuiDialogSelectOption<string>[] = [
    {
      title: `Debug mode: ${config.debug ? "on" : "off"}`,
      value: "debug",
      description: "Toggle routing/model diagnostic toasts immediately",
    },
    { title: "View debug log", value: "view-log", description: "Show recent agent-variants.debug.log entries" },
    { title: "Clear debug log", value: "clear-log", description: "Empty agent-variants.debug.log" },
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
    case "view-log":
      await viewDebugLog(api)
      return debugAdvancedMenu(api, config, settings)
    case "clear-log":
      await clearDebugLog(api)
      return debugAdvancedMenu(api, config, settings)
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

// Plugin entrypoint.

function registerConfigureCommand(api: TuiPluginApi, run: () => Promise<void>) {
  const command = {
    namespace: "palette",
    name: "agent-variants.configure",
    title: "Agent Variants: Configure",
    desc: "Manage agent model variants",
    category: "Plugins",
    slashName: "agent-variants",
    run,
  }
  const apiWithKeymap = api as TuiPluginApi & {
    keymap?: {
      registerLayer?: (layer: { commands: Array<typeof command>; bindings: unknown[] }) => () => void
    }
  }
  if (typeof apiWithKeymap.keymap?.registerLayer === "function") {
    return apiWithKeymap.keymap.registerLayer({ commands: [command], bindings: [] })
  }
  return api.command?.register(() => [
    {
      title: "Agent Variants: Configure",
      value: "agent-variants.configure",
      description: "Manage agent model variants",
      category: "Plugins",
      slash: {
        name: "agent-variants",
      },
      onSelect: run,
    },
  ])
}

const tui: TuiPlugin = async (api) => {
  const unregister = registerConfigureCommand(api, async () => {
    const config = loadSidecar(defaultSidecarPath())
    await mainMenu(api, config, { subagentCapableOnly: true, hotChanges: false, restartReasons: [] })
  })

  api.lifecycle.onDispose(() => {
    unregister?.()
  })
}

export default { id: "agent-variants", tui }
