import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import {
  BUILTIN_AGENT_DESCRIPTIONS,
  debugLogPath,
  defaultConfigDir,
  defaultSidecarPath,
  diagnoseConfig,
  loadSidecar,
  saveSidecar,
  variantName,
  type AgentPatch,
  type SidecarConfig,
  type VariantConfig,
} from "./config.js"

// Types for sidecar entries.

type AgentEntry = SidecarConfig["agents"][string]
type ModelEntry = SidecarConfig["models"][string]

// Constants.

const BUILTIN_AGENT_KEYS = Object.keys(BUILTIN_AGENT_DESCRIPTIONS)
const THEME_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"] as const

interface FieldDef {
  key: string
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

// Helpers.

function agentsFromState(api: TuiPluginApi): string[] {
  const configured = Object.keys(api.state.config.agent ?? {})
  const merged = new Set([...BUILTIN_AGENT_KEYS, ...configured])
  return [...merged].sort()
}

function modelOptions(api: TuiPluginApi, config: SidecarConfig): TuiDialogSelectOption<string>[] {
  const opts: TuiDialogSelectOption<string>[] = []

  for (const [key, raw] of Object.entries(config.models)) {
    const entry = raw as ModelEntry
    opts.push({
      title: `${key} -> ${entry.model}`,
      value: key,
      description: entry.label ?? entry.model,
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
    title: "Custom model...",
    value: "__custom__",
    description: "Type a provider/model ID manually",
    category: "Custom",
  })

  return opts
}

function colorOptions(): TuiDialogSelectOption<string>[] {
  const opts: TuiDialogSelectOption<string>[] = THEME_COLORS.map((c) => ({
    title: c,
    value: c,
    category: "Theme colors",
  }))
  opts.push({
    title: "Custom hex...",
    value: "__custom__",
    description: "Enter a hex color like #FF5733",
    category: "Custom",
  })
  return opts
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
    ui.dialog.replace(() =>
      ui.DialogSelect<Value>({
        title: props.title,
        placeholder: props.placeholder ?? "Type to filter...",
        options: props.options,
        current: props.current,
        flat: props.options.length < 15,
        onSelect: (opt) => {
          ui.dialog.clear()
          resolve(opt.value)
        },
      }),
    )
  })
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
    ui.dialog.replace(() =>
      ui.DialogPrompt({
        title: props.title,
        placeholder: props.placeholder,
        value: props.value ?? "",
        onConfirm: (val) => {
          ui.dialog.clear()
          resolve(val || undefined)
        },
        onCancel: () => {
          ui.dialog.clear()
          resolve(undefined)
        },
      }),
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
    ui.dialog.replace(() =>
      ui.DialogConfirm({
        title: props.title,
        message: props.message,
        onConfirm: () => {
          ui.dialog.clear()
          resolve(true)
        },
        onCancel: () => {
          ui.dialog.clear()
          resolve(false)
        },
      }),
    )
  })
}

function showAlert(ui: UI, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    ui.dialog.replace(() =>
      ui.DialogAlert({
        title: props.title,
        message: props.message,
        onConfirm: () => {
          ui.dialog.clear()
          resolve()
        },
      }),
    )
  })
}

// Main wizard flows.

async function addVariant(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const aliases = generatedAliasSet(config)
  const agents = agentsFromState(api).filter((agent) => !aliases.has(agent))
  if (agents.length === 0) {
    await showAlert(api.ui, { title: "No agents", message: "No agents available to add a variant to." })
    return config
  }

  const agentOpts: TuiDialogSelectOption<string>[] = agents.map((a) => ({
    title: a,
    value: a,
    description: BUILTIN_AGENT_DESCRIPTIONS[a] ?? api.state.config.agent?.[a]?.description,
  }))
  const agent = await showSelect(api.ui, { title: "Add variant - pick parent agent", options: agentOpts })
  if (!agent) return config

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
  api.ui.toast({ variant: "success", title: "Variant added", message: name })
  return next
}

async function editParentFields(
  api: TuiPluginApi,
  config: SidecarConfig,
  agent: string,
): Promise<SidecarConfig> {
  const next = structuredClone(config)
  if (!next.agents[agent]) {
    next.agents[agent] = { parent: {}, variants: {} }
  }
  const parent = (next.agents[agent] as AgentEntry).parent as Record<string, unknown>

  const fieldOpts: TuiDialogSelectOption<string>[] = EDITABLE_FIELDS.map((f) => {
    const current = parent[f.key]
    return {
      title: f.label,
      value: f.key,
      description: current !== undefined ? `Current: ${truncate(String(current), 60)}` : "(not set)",
    }
  })
  fieldOpts.push({
    title: "< Back",
    value: "__back__",
    description: "Return to main menu",
  })

  const field = await showSelect(api.ui, {
    title: `Edit parent fields - ${agent}`,
    options: fieldOpts,
  })
  if (!field || field === "__back__") return config

  const currentValue = formatInputValue(parent[field])
  const value = await promptForField(api, field, currentValue)
  if (value === undefined) return config

  if (value === "") {
    delete parent[field]
  } else {
    parent[field] = value
  }

  api.ui.toast({ variant: "success", title: "Field updated", message: `${field} for ${agent}` })
  return next
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
        const picked = await showSelect(api.ui, { title: "Pick color", options: colorOptions() })
        if (picked === "__custom__") {
          const hex = await showPrompt(api.ui, { title: "Hex color", placeholder: "#FF5733" })
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

    const value = await promptForField(api, field.key, formatInputValue(variant[field.key]))
    if (value !== undefined && value !== "") {
      variant[field.key] = value
    }
  }

  return variant as VariantConfig
}

async function editVariant(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const agentsWithVariants = agentEntries(config).filter(([, e]) => Object.keys(e.variants).length > 0)
  if (agentsWithVariants.length === 0) {
    await showAlert(api.ui, { title: "No variants", message: "Add a variant first." })
    return config
  }

  const agentOpts: TuiDialogSelectOption<string>[] = agentsWithVariants.map(([a, e]) => ({
    title: a,
    value: a,
    description: `${Object.keys(e.variants).length} variant(s)`,
  }))
  const agent = await showSelect(api.ui, { title: "Edit variant - pick agent", options: agentOpts })
  if (!agent) return config

  const entries = variantEntries(config.agents[agent] as AgentEntry)
  const varOpts: TuiDialogSelectOption<string>[] = entries.map(([k, v]) => ({
    title: `${variantName(agent, k, v)}  (${k})`,
    value: k,
    description: modelDescription(v.model, config),
  }))
  const key = await showSelect(api.ui, { title: `Edit variant of "${agent}"`, options: varOpts })
  if (!key) return config

  const existing = (config.agents[agent] as AgentEntry).variants[key] as VariantConfig
  const existingRec = existing as Record<string, unknown>

  const fieldOpts: TuiDialogSelectOption<string>[] = EDITABLE_FIELDS.map((f) => ({
    title: f.label,
    value: f.key,
    description: existingRec[f.key] !== undefined ? `Current: ${truncate(String(existingRec[f.key]), 60)}` : "(not set)",
  }))
  fieldOpts.push({
    title: "Display name",
    value: "name",
    description: existing.name ? `Current: ${existing.name}` : `Default: ${agent}-${key}`,
  })
  fieldOpts.push({
    title: "< Back",
    value: "__back__",
    description: "Return to main menu",
  })

  const field = await showSelect(api.ui, {
    title: `Edit field - ${variantName(agent, key, existing)}`,
    options: fieldOpts,
  })
  if (!field || field === "__back__") return config

  const next = structuredClone(config)
  const target = (next.agents[agent] as AgentEntry).variants[key] as Record<string, unknown>

  if (field === "name") {
    const val = await showPrompt(api.ui, {
      title: "Display name",
      value: target.name as string | undefined,
      placeholder: `${agent}-${key}`,
    })
    if (val === undefined) return config
    target.name = val || undefined
  } else if (field === "model") {
    const models = modelOptions(api, next)
    const picked = await showSelect(api.ui, { title: "Select model", options: models, current: existing.model })
    if (!picked) return config
    if (picked === "__custom__") {
      const custom = await showPrompt(api.ui, { title: "Custom model ID", placeholder: "provider/model-id" })
      if (custom) target.model = custom
    } else {
      target.model = picked
    }
  } else if (field === "color") {
    const picked = await showSelect(api.ui, { title: "Pick color", options: colorOptions() })
    if (picked === "__custom__") {
      const hex = await showPrompt(api.ui, { title: "Hex color", placeholder: "#FF5733" })
      if (hex) target.color = hex
    } else if (picked) {
      target.color = picked
    }
  } else {
    const val = await promptForField(api, field, formatInputValue(existingRec[field]))
    if (val === undefined) return config
    if (val === "") {
      delete target[field]
    } else {
      target[field] = val
    }
  }

  const updated = next.agents[agent] as AgentEntry
  const updatedVariant = updated.variants[key] as VariantConfig
  api.ui.toast({ variant: "success", title: "Variant updated", message: variantName(agent, key, updatedVariant) })
  return next
}

async function toggleDisable(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const items: TuiDialogSelectOption<{ agent: string; variant?: string }>[] = []

  for (const [agent, raw] of agentEntries(config)) {
    const entry = raw as AgentEntry
    const parentDisabled = entry.disable === true
    items.push({
      title: `${parentDisabled ? "x" : "ok"} ${agent} (parent)`,
      value: { agent },
      description: parentDisabled ? "Disabled - no variants active" : "Enabled",
      category: "Parents",
    })
    for (const [key, rawVar] of variantEntries(entry)) {
      const variant = rawVar as VariantConfig
      const vDisabled = variant.disable === true
      items.push({
        title: `  ${vDisabled ? "x" : "ok"} ${variantName(agent, key, variant)}`,
        value: { agent, variant: key },
        description: vDisabled ? "Disabled" : "Enabled",
        category: "Variants",
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

  const picked = await showSelect(api.ui, { title: "Toggle disable", options: items })
  if (!picked || picked.agent === "__back__") return config

  const next = structuredClone(config)

  if (!picked.variant) {
    if (!next.agents[picked.agent]) {
      next.agents[picked.agent] = { parent: {}, variants: {} }
    }
    const entry = next.agents[picked.agent] as AgentEntry
    entry.disable = !entry.disable
    const state = entry.disable ? "disabled" : "enabled"
    api.ui.toast({ variant: "info", title: `${picked.agent} ${state}`, message: `Parent ${state}` })
  } else {
    const entry = next.agents[picked.agent] as AgentEntry | undefined
    const variant = entry?.variants[picked.variant] as VariantConfig | undefined
    if (variant) {
      variant.disable = !variant.disable
      const state = variant.disable ? "disabled" : "enabled"
      api.ui.toast({ variant: "info", title: `${variantName(picked.agent, picked.variant, variant)} ${state}`, message: `Variant ${state}` })
    }
  }

  return next
}

async function deleteVariant(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const agentsWithVariants = agentEntries(config).filter(([, e]) => Object.keys(e.variants).length > 0)
  if (agentsWithVariants.length === 0) {
    await showAlert(api.ui, { title: "No variants", message: "Nothing to delete." })
    return config
  }

  const agentOpts: TuiDialogSelectOption<string>[] = agentsWithVariants.map(([a]) => ({
    title: a,
    value: a,
  }))
  const agent = await showSelect(api.ui, { title: "Delete variant - pick agent", options: agentOpts })
  if (!agent) return config

  const agentEntry = config.agents[agent] as AgentEntry
  const entries = variantEntries(agentEntry)
  const varOpts: TuiDialogSelectOption<string>[] = entries.map(([k, v]) => ({
    title: `${variantName(agent, k, v)}  (${k})`,
    value: k,
    description: modelDescription(v.model, config),
  }))
  const key = await showSelect(api.ui, { title: `Delete variant from "${agent}"`, options: varOpts })
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

  api.ui.toast({ variant: "success", title: "Variant deleted", message: name })
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
      lines.push(`  ${key} -> ${entry.model}${entry.label ? `  (${entry.label})` : ""}`)
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

  await showAlert(api.ui, { title: "Configuration Preview", message: lines.join("\n") })
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
  await showAlert(api.ui, { title: "Diagnostics", message: lines.join("\n") })
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

async function saveConfig(api: TuiPluginApi, config: SidecarConfig): Promise<void> {
  try {
    saveSidecar(config, defaultSidecarPath())
    api.ui.toast({
      variant: "success",
      title: "Saved",
      message: "Configuration written with backup. Restart OpenCode to apply.",
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
): Promise<unknown> {
  if (field === "model") {
    const config = loadSidecar(defaultSidecarPath())
    const models = modelOptions(api, config)
    const picked = await showSelect(api.ui, { title: "Select model", options: models, current })
    if (!picked) return undefined
    if (picked === "__custom__") {
      return showPrompt(api.ui, { title: "Custom model ID", placeholder: "provider/model-id" })
    }
    return picked
  }

  if (field === "color") {
    const picked = await showSelect(api.ui, { title: "Pick color", options: colorOptions() })
    if (picked === "__custom__") {
      return showPrompt(api.ui, { title: "Hex color", placeholder: "#FF5733" })
    }
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

async function mainMenu(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const agentCount = Object.keys(config.agents).length
  const vCount = variantCount(config)

  const opts: TuiDialogSelectOption<string>[] = [
    { title: "Add variant...", value: "add", description: "Create a new agent variant" },
    { title: "Edit parent fields...", value: "edit-parent", description: "Override fields on an agent parent" },
    { title: "Edit variant...", value: "edit-variant", description: "Change fields on an existing variant" },
    { title: "Toggle disable...", value: "toggle", description: "Enable or disable agents/variants" },
    { title: "Run diagnostics", value: "diagnostics", description: "Check models, conflicts, plugin install, and disabled variants" },
    {
      title: `Debug mode: ${config.debug ? "on" : "off"}`,
      value: "debug",
      description: "Toggle routing/model diagnostic toasts immediately",
    },
    { title: "View debug log", value: "view-log", description: "Show recent agent-variants.debug.log entries" },
    { title: "Clear debug log", value: "clear-log", description: "Empty agent-variants.debug.log" },
    { title: "Delete variant...", value: "delete", description: "Remove a variant" },
    { title: "Preview configuration", value: "preview", description: `View current config (${agentCount} agents, ${vCount} variants)` },
    { title: "Save & exit", value: "save", description: "Write to disk with backup" },
  ]

  const action = await showSelect(api.ui, {
    title: "Agent Variants",
    options: opts,
    placeholder: "Choose an action...",
  })

  switch (action) {
    case "add":
      return mainMenu(api, await addVariant(api, config))
    case "edit-parent":
      return editParentFlow(api, config)
    case "edit-variant":
      return mainMenu(api, await editVariant(api, config))
    case "toggle":
      return mainMenu(api, await toggleDisable(api, config))
    case "diagnostics":
      await runDiagnostics(api, config)
      return mainMenu(api, config)
    case "debug":
      return mainMenu(api, await toggleDebug(api, config))
    case "view-log":
      await viewDebugLog(api)
      return mainMenu(api, config)
    case "clear-log":
      await clearDebugLog(api)
      return mainMenu(api, config)
    case "delete":
      return mainMenu(api, await deleteVariant(api, config))
    case "preview":
      await previewConfig(api, config)
      return mainMenu(api, config)
    case "save":
      await saveConfig(api, config)
      return config
    default:
      return config
  }
}

async function editParentFlow(api: TuiPluginApi, config: SidecarConfig): Promise<SidecarConfig> {
  const aliases = generatedAliasSet(config)
  const agents = agentsFromState(api).filter((agent) => !aliases.has(agent))
  const opts: TuiDialogSelectOption<string>[] = agents.map((a) => {
    const entry = config.agents[a] as AgentEntry | undefined
    const overrides = entry ? Object.keys(entry.parent).length : 0
    return {
      title: a,
      value: a,
      description: overrides > 0 ? `${overrides} parent override(s)` : "No overrides",
    }
  })
  opts.push({
    title: "< Back",
    value: "__back__",
    description: "Return to main menu",
  })

  const agent = await showSelect(api.ui, { title: "Edit parent fields - pick agent", options: opts })
  if (!agent || agent === "__back__") return mainMenu(api, config)

  const updated = await editParentFields(api, config, agent)
  return mainMenu(api, updated)
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
    await mainMenu(api, config)
  })

  api.lifecycle.onDispose(() => {
    unregister?.()
  })
}

export default { id: "agent-variants", tui }
