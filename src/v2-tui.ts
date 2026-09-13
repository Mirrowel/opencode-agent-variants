/**
 * OpenCode v2 TUI plugin implementation: builds a `TuiHostApi` adapter over
 * the v2 TUI plugin context so the unchanged wizard (wizard.tsx) runs on both
 * hosts, registers the palette/slash command, and delivers startup
 * diagnostics as toasts from the TUI side (v2 has no server-side toast API,
 * but both processes can compute the same diagnostics from the sidecar and
 * the shared provider/agent catalogs).
 *
 * Dialog bridging: the v1 api exposes dialog components (DialogSelect, …)
 * that RETURN JSX rendered inside an enclosing `dialog.replace(render)`
 * entry. The v2 api only offers promise-based dialogs that open their own
 * host entry. The bridge reconciles the two: `replace()` invokes the render
 * thunk synchronously — if it returns renderable content the v2 dialog shows
 * it as one entry with the caller's onClose; if it returned nothing (because
 * a DialogX bridge already opened the host's own dialog), the caller's
 * onClose is parked and invoked when that nested dialog is dismissed without
 * a result (esc), which is exactly when v1 would have fired it.
 */

import { createSignal } from "solid-js"
import { defaultConfigDir, defaultSidecarPath, diagnoseConfig, emptyConfig, loadSidecar, type AgentMode } from "./config.js"
import { declarePaletteCategory, schedulePaletteReconcile } from "./palette-category.js"
import type { TuiHostApi, TuiHostKeymapLayer } from "./tui-host.js"
import { applyWizardUiSettings, mainMenu, newWizardSettings } from "./wizard.js"
import type { V2KeymapCommand, V2KeymapLayer, V2TuiContext, V2TuiSetup } from "./v2-types.js"

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => resolve(undefined), ms)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(handle)
        resolve(value)
      },
      () => {
        clearTimeout(handle)
        resolve(undefined)
      },
    )
  })
}

function pickThemeToken(source: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * The wire `location` query uses `workspace`; the plugin-facing LocationRef
 * uses `workspaceID`. Translate at the boundary.
 */
function wireLocation(ref: { directory: string; workspaceID?: string } | undefined): Record<string, string> | undefined {
  if (!ref) return undefined
  return ref.workspaceID !== undefined ? { directory: ref.directory, workspace: ref.workspaceID } : { directory: ref.directory }
}

function buildV2Theme(context: V2TuiContext) {
  // Read theme/mode live inside the getter so mid-session theme switches
  // reach the wizard (the host resolves a fresh token set per change).
  return {
    get current() {
      const theme = context.theme
      const dark = context.themeMode === "dark"
      const text = pickThemeToken(theme, "text", "default")
      return {
        text,
        textMuted: pickThemeToken(theme, "text", "subdued") ?? text,
        background: pickThemeToken(theme, "background", "default"),
        backgroundPanel: pickThemeToken(theme, "background", "surface", "offset") ?? pickThemeToken(theme, "background", "default"),
        primary: pickThemeToken(theme, "text", "action", "primary", "selected") ?? text,
        secondary: pickThemeToken(theme, "hue", dark ? "interactive" : "neutral", dark ? 300 : 700) ?? text,
        accent: pickThemeToken(theme, "hue", "accent", dark ? 200 : 800) ?? text,
        success: pickThemeToken(theme, "text", "feedback", "success", "default") ?? text,
        warning: pickThemeToken(theme, "text", "feedback", "warning", "default") ?? text,
        error: pickThemeToken(theme, "text", "feedback", "error", "default") ?? text,
        info: pickThemeToken(theme, "text", "feedback", "info", "default") ?? text,
      }
    },
  }
}

function convertKeymapLayer(layer: TuiHostKeymapLayer): V2KeymapLayer {
  const bindingsByName = new Map<string, string[]>()
  for (const binding of layer.bindings ?? []) {
    if (!binding?.cmd) continue
    const keys = bindingsByName.get(binding.cmd) ?? []
    keys.push(binding.key)
    bindingsByName.set(binding.cmd, keys)
  }
  // Named commands (id) receive the key event from the host runner, keep
  // user-configurable bindings, and — unlike inline commands — do not
  // require a bind string.
  const commands: V2KeymapCommand[] = (layer.commands ?? []).map((command) => ({
    id: command.name,
    title: command.title ?? command.name,
    description: command.desc,
    ...(bindingsByName.get(command.name)?.length ? { bind: bindingsByName.get(command.name)!.join(",") } : {}),
    run: (_input?: string, event?: { preventDefault?: () => void; stopPropagation?: () => void }) =>
      command.run({ event: event ? { preventDefault: () => event.preventDefault?.(), stopPropagation: () => event.stopPropagation?.() } : undefined }),
  }))
  return { mode: "global", priority: layer.priority, commands }
}

/** Builds the v1-shaped `TuiHostApi` facade over a v2 TUI plugin context. */
export function buildV2HostApi(context: V2TuiContext): TuiHostApi {
  const disposeFns: Array<() => void> = []
  const locationRef = () => {
    try {
      return context.location
        ? (context.location as { directory: string; workspaceID?: string })
        : context.data.location.default()
    } catch {
      return undefined
    }
  }
  /** Wire form ({workspace}) for direct client calls. */
  const wireLoc = () => wireLocation(locationRef())

  // --- kv: synchronous read-your-writes mirror over the persistent store ---
  const [kvStore, kvMutate] = context.storage.store("kv", { initial: {} as Record<string, unknown> })
  const kvMirror: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(kvStore as Record<string, unknown>)) kvMirror[key] = value
  const kv = {
    get<Value = unknown>(key: string, fallback?: Value): Value {
      const value = key in kvMirror ? kvMirror[key] : (kvStore as Record<string, unknown>)[key]
      return (value === undefined ? fallback : value) as Value
    },
    set(key: string, value: unknown) {
      kvMirror[key] = value
      void kvMutate((draft) => {
        draft[key] = value
      }).catch(() => undefined)
    },
    ready: true,
  }

  // --- config docs cache (plugin entries, default agent) ---
  let configDocsCache: { pluginEntries: unknown[]; defaultAgent?: string } = { pluginEntries: [] }
  const refreshConfigDocs = async () => {
    try {
      const getter = (context.client as { config?: { get?: (input: unknown) => Promise<unknown> } }).config?.get
      if (typeof getter !== "function") return
      const result = await withTimeout(getter({ location: wireLoc() }), 5000)
      const docs = Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])
      const pluginEntries: unknown[] = []
      let defaultAgent: string | undefined
      for (const doc of docs as Array<{ type?: string; info?: Record<string, unknown> }>) {
        if (doc?.type !== "document" || !doc.info) continue
        if (typeof doc.info.default_agent === "string") defaultAgent = doc.info.default_agent
        const plugins = (doc.info.plugins ?? doc.info.plugin) as unknown
        if (Array.isArray(plugins)) {
          for (const entry of plugins) {
            if (typeof entry === "string") pluginEntries.push(entry)
            else if (entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string") {
              pluginEntries.push((entry as { package: string }).package)
            }
          }
        }
      }
      configDocsCache = { pluginEntries, defaultAgent }
    } catch {
      /* keep previous cache */
    }
  }

  // --- v1-shaped live state over the v2 data stores ---
  const buildProviderList = () => {
    const providers = context.data.location.provider.list() ?? []
    const models = context.data.location.model.list() ?? []
    const byProvider = new Map<string, Record<string, { id: string; name: string; variants?: Record<string, unknown> }>>()
    for (const model of models) {
      if (!model?.providerID) continue
      const id = model.modelID ?? model.id ?? ""
      if (!id) continue
      const variants: Record<string, unknown> = {}
      for (const variant of model.variants ?? []) {
        const variantId = typeof variant === "string" ? variant : variant?.id
        if (variantId) variants[variantId] = {}
      }
      const bucket = byProvider.get(model.providerID) ?? {}
      bucket[id] = { id, name: model.name ?? id, ...(Object.keys(variants).length ? { variants } : {}) }
      byProvider.set(model.providerID, bucket)
    }
    return providers.map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      models: byProvider.get(provider.id) ?? {},
    }))
  }

  const state = {
    get config() {
      const agents = context.data.location.agent.list() ?? []
      const agentRecord: Record<string, any> = {}
      for (const agent of agents) {
        // Hidden agents (our av: clones, system title/summary/compaction)
        // must not surface as user-selectable parents in the wizard.
        if (agent.hidden) continue
        agentRecord[agent.id] = {
          name: agent.name,
          mode: agent.mode,
          hidden: agent.hidden,
          color: agent.color,
          description: agent.description,
          prompt: agent.system,
          model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : undefined,
        }
      }
      return {
        agent: agentRecord,
        default_agent: configDocsCache.defaultAgent,
        plugin: configDocsCache.pluginEntries,
      }
    },
    get provider() {
      return buildProviderList()
    },
    get path() {
      const dir = locationRef()?.directory ?? process.cwd()
      return { config: defaultConfigDir(), directory: dir, worktree: dir }
    },
  }

  // --- dialog bridging (see module doc comment) ---
  const dialog = context.ui.dialog
  let nestedOnClose: (() => void) | undefined
  const settleNested = (dismissed: boolean) => {
    const onClose = nestedOnClose
    nestedOnClose = undefined
    if (dismissed) onClose?.()
  }

  const api: TuiHostApi = {
    hostVersion: 2,
    app: { version: context.app?.version },
    client: context.client,
    kv,
    lifecycle: {
      onDispose(fn: () => void) {
        disposeFns.push(fn)
      },
    },
    mode: {
      push(mode: string) {
        try {
          return context.keymap.mode.push(mode)
        } catch {
          return () => undefined
        }
      },
    },
    renderer: {
      get root() {
        return (context.renderer as { root?: unknown } | undefined)?.root
      },
    },
    state,
    theme: buildV2Theme(context),
    ui: {
      toast: (input) => {
        try {
          context.ui.toast.show({ title: input.title, message: input.message, variant: input.variant, duration: input.duration })
        } catch {
          /* toasts must never crash the wizard */
        }
      },
      dialog: {
        replace(renderer: unknown, onClose?: () => void) {
          nestedOnClose = undefined
          let content: unknown
          try {
            content = typeof renderer === "function" ? (renderer as () => unknown)() : renderer
          } catch {
            content = undefined
          }
          if (content === undefined || content === null) {
            // A DialogX bridge opened the host's own dialog; esc/dismiss
            // paths settle through it instead of a dialog entry here.
            nestedOnClose = onClose
            return
          }
          const element = content
          dialog.show(() => element, onClose)
        },
        clear() {
          nestedOnClose = undefined
          dialog.clear()
        },
        setSize(size: string) {
          try {
            dialog.set({ size })
          } catch {
            /* size hints are best-effort */
          }
        },
      },
      DialogSelect(props) {
        void dialog
          .select({
            title: props.title,
            placeholder: props.placeholder,
            current: props.current,
            options: props.options.map((option) => ({
              title: option.title,
              value: option.value,
              description: option.description,
              category: option.category,
              disabled: option.disabled,
            })),
          })
          .then((value) => {
            if (value === undefined) {
              // v1 fires the enclosing dialog's onClose on esc.
              settleNested(true)
              return
            }
            settleNested(false)
            // v1's onSelect receives the full option object; the v2 dialog
            // resolves with the value, so recover the option it picked.
            const option = props.options.find((item) => item.value === value)
            if (option) props.onSelect(option)
          })
          .catch(() => settleNested(true))
      },
      DialogPrompt(props) {
        void dialog
          .prompt({ title: props.title, placeholder: props.placeholder, value: props.value })
          .then((value) => {
            settleNested(value === undefined)
            if (value === undefined) props.onCancel?.()
            else props.onConfirm(value)
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogConfirm(props) {
        void dialog
          .confirm({ title: props.title, message: props.message, label: { confirm: props.confirmLabel } })
          .then((result) => {
            settleNested(result !== true)
            if (result === true) props.onConfirm()
            else props.onCancel?.()
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogAlert(props) {
        void dialog
          .alert({ title: props.title, message: props.message })
          .then(() => {
            settleNested(false)
            props.onConfirm?.()
          })
          .catch(() => {
            settleNested(true)
            props.onConfirm?.()
          })
      },
    },
    keymap: {
      registerLayer(layer: TuiHostKeymapLayer) {
        // v2 layers are reactive: the input function re-evaluates when the
        // signal flips, so "unregistering" disables the layer. (The layer
        // computation itself lives until the host disposes the plugin — v2
        // has no per-layer unregister — but a disabled layer is inert.)
        const [active, setActive] = createSignal(true)
        try {
          context.keymap.layer(() =>
            active()
              ? convertKeymapLayer(layer)
              : { mode: "global", enabled: false, commands: [], bindings: [] },
          )
        } catch {
          return () => undefined
        }
        return () => {
          setActive(false)
        }
      },
    },
  }

  return Object.assign(api, {
    __disposeFns: disposeFns,
    __refreshConfigDocs: refreshConfigDocs,
    __startupSync: async () => {
      try {
        await withTimeout(context.data.location.sync(locationRef()), 8000)
      } catch {
        /* stores may still be syncing; the wizard degrades gracefully */
      }
      await refreshConfigDocs()
    },
  }) as TuiHostApi & { __disposeFns: Array<() => void>; __refreshConfigDocs: () => Promise<void>; __startupSync: () => Promise<void> }
}

async function openWizard(api: TuiHostApi) {
  const extended = api as TuiHostApi & { __refreshConfigDocs?: () => Promise<void> }
  void extended.__refreshConfigDocs?.()
  const config = (() => {
    try {
      return loadSidecar(defaultSidecarPath())
    } catch {
      return emptyConfig()
    }
  })()
  applyWizardUiSettings(api, config)
  await mainMenu(api, config, newWizardSettings(true))
}

async function runStartupDiagnostics(context: V2TuiContext, api: TuiHostApi) {
  try {
    const extended = api as TuiHostApi & { __startupSync: () => Promise<void> }
    await extended.__startupSync()
    const sidecar = (() => {
      try {
        return loadSidecar(defaultSidecarPath())
      } catch {
        return emptyConfig()
      }
    })()
    const agents = context.data.location.agent.list() ?? []
    const agentModes: Record<string, AgentMode> = {}
    const agentIds: string[] = []
    for (const agent of agents) {
      agentIds.push(agent.id)
      agentModes[agent.id] = agent.mode
    }
    const diagnostics = diagnoseConfig(sidecar, {
      agents: agentIds,
      providers: api.state.provider,
      pluginEntries: api.state.config?.plugin,
      agentModes,
    })
    for (const diagnostic of diagnostics) {
      if (diagnostic.level === "info") continue
      api.ui.toast({
        variant: diagnostic.level === "error" ? "error" : "warning",
        title: "Agent Variants",
        message: diagnostic.message,
        duration: 15000,
      })
    }
  } catch {
    /* startup diagnostics are best-effort */
  }
}

/**
 * v2 TUI plugin setup: registers the palette/slash command (one reactive
 * keymap layer), mirrors v1's TUI-side startup behavior, and surfaces config
 * diagnostics as toasts.
 */
export function createV2TuiSetup(): V2TuiSetup {
  return async (context: V2TuiContext) => {
    const api = buildV2HostApi(context)
    const extended = api as typeof api & { __disposeFns: Array<() => void> }

    const command = {
      id: "agent-variants.configure",
      title: "Agent Variants: Configure",
      description: "Manage agent model variants",
      category: "",
      group: "",
      palette: true as const,
      slash: { name: "agent-variants" },
      run: () => void openWizard(api),
    }
    command.category = command.group = declarePaletteCategory("Agent Variants", command)
    schedulePaletteReconcile()
    const [paletteActive, setPaletteActive] = createSignal(true)
    try {
      context.keymap.layer(() =>
        paletteActive()
          ? { mode: "global", commands: [command as V2KeymapCommand] }
          : { mode: "global", enabled: false, commands: [] },
      )
    } catch {
      /* command registration failure must not break the plugin */
    }

    void runStartupDiagnostics(context, api)

    return () => {
      setPaletteActive(false)
      for (const dispose of extended.__disposeFns) {
        try {
          dispose()
        } catch {
          /* disposal must not throw */
        }
      }
    }
  }
}
