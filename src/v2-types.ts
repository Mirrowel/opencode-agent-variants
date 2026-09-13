/**
 * Minimal structural types for the OpenCode v2 plugin context subset used by
 * this plugin. Hand-written on purpose: the v2 plugin SDK is still beta, the
 * published `@opencode-ai/plugin` npm package resolves to the v1 shape, and a
 * v2 plugin module must not import the plugin SDK at runtime anyway
 * (`Plugin.define` is an identity function — a plain `{ id, setup }` default
 * export is the whole contract). Keep these in sync with the beta repo
 * (packages/plugin/src/promise + src/tui) when the API settles.
 */

// ---------------------------------------------------------------------------
// Server context
// ---------------------------------------------------------------------------

export type V2ModelRef = { providerID: string; id: string; variant?: string }

export type V2AgentInfo = {
  id: string
  name: string
  model?: V2ModelRef
  request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> }
  system?: string | undefined
  description?: string | undefined
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  color?: string | undefined
  steps?: number | undefined
  permissions: unknown[]
}

export type V2AgentEditor = {
  list(): readonly V2AgentInfo[]
  get(id: string): V2AgentInfo | undefined
  default(id: string | undefined): void
  update(id: string, update: (agent: V2AgentInfo) => void): void
  remove(id: string): void
}

export type V2Registration = { dispose: () => Promise<void> | void }

export type V2Transform<Input> = (callback: (input: Input) => void) => Promise<V2Registration>

export type V2ExecuteBeforeEvent = {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
}

export type V2ExecuteAfterEvent = {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
} & (
  | { status: "completed"; result: { output?: unknown; content?: unknown; metadata?: Record<string, unknown> } }
  | { status: "error"; error: unknown }
)

export type V2SystemPart = { type: string; text?: string }

export type V2SessionContextEvent = {
  sessionID: string
  agent: string
  model: V2ModelRef
  system: V2SystemPart[]
  messages: unknown[]
  tools: Record<string, unknown>
  generation: Record<string, unknown>
  providerOptions: Record<string, unknown>
}

export type V2SessionInfo = {
  id?: string
  parentID?: string
  agent?: string
  model?: V2ModelRef
}

export type V2PluginContext = {
  agent: {
    transform: V2Transform<V2AgentEditor>
    reload(): Promise<void> | void
  }
  tool: {
    hook(
      name: "execute.before",
      callback: (event: V2ExecuteBeforeEvent) => Promise<void> | void,
    ): Promise<V2Registration>
    hook(
      name: "execute.after",
      callback: (event: V2ExecuteAfterEvent) => Promise<void> | void,
    ): Promise<V2Registration>
  }
  session: {
    hook(
      name: "context",
      callback: (event: V2SessionContextEvent) => Promise<void> | void,
    ): Promise<V2Registration>
    get(input: { sessionID: string }): Promise<unknown>
  }
  app?: { name?: string; version?: string; channel?: string }
}

export type V2ServerSetup = (context: V2PluginContext) => Promise<(() => void) | void> | (() => void) | void

// ---------------------------------------------------------------------------
// TUI context
// ---------------------------------------------------------------------------

export type V2TuiKeyEvent = {
  preventDefault?(): void
  stopPropagation?(): void
  [key: string]: unknown
}

export type V2KeymapCommand = {
  id?: string
  title?: string
  description?: string
  group?: string
  enabled?: boolean | (() => boolean)
  bind?: false | string
  palette?: true
  slash?: { name: string; aliases?: string[]; arguments?: true }
  suggested?: boolean | (() => boolean)
  run: (input?: string, event?: V2TuiKeyEvent) => void | false | Promise<void>
}

export type V2KeymapLayer = {
  mode?: string
  enabled?: boolean | (() => boolean)
  priority?: number
  commands?: readonly V2KeymapCommand[]
  bindings?: readonly string[]
}

export type V2DialogSelectOption<Value> = {
  title: string
  value: Value
  description?: string
  category?: string
  disabled?: boolean
}

export type V2LocationRef = { directory: string; workspaceID?: string }

export type V2AgentListEntry = V2AgentInfo

export type V2ProviderListEntry = {
  id: string
  name: string
  activation?: string
  canonical?: string
}

export type V2ModelListEntry = {
  id?: string
  modelID?: string
  providerID: string
  name?: string
  variants?: Array<{ id: string } | string>
  enabled?: boolean
  status?: string
}

export type V2TuiContext = {
  options: Readonly<Record<string, unknown>>
  location?: unknown
  app: { version?: string; channel?: string }
  renderer: { root?: unknown }
  client: any
  data: {
    location: {
      default(): V2LocationRef
      sync(location?: V2LocationRef): Promise<void>
      invalidate(location?: V2LocationRef): void
      agent: V2LocationCollection<V2AgentListEntry>
      provider: V2LocationCollection<V2ProviderListEntry>
      model: V2LocationCollection<V2ModelListEntry>
    }
  }
  keymap: {
    layer(input: () => V2KeymapLayer): void
    mode: { current(): string; push(mode: string): () => void }
  }
  storage: {
    store<Value extends object>(
      key: string,
      options: { initial: Value },
    ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  }
  theme: V2ResolvedTheme
  themeMode: "dark" | "light"
  ui: {
    dialog: {
      show(render: () => unknown, onClose?: () => void): void
      set(options: { size?: string; centered?: boolean }): void
      clear(): void
      alert(options: { title: string; message: string }): Promise<void>
      confirm(options: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }): Promise<boolean | undefined>
      prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
      select<Value>(options: {
        title: string
        placeholder?: string
        current?: Value
        options: readonly V2DialogSelectOption<Value>[]
      }): Promise<Value | undefined>
    }
    toast: { show(options: { title?: string; message: string; variant?: string; duration?: number }): void }
  }
}

export type V2LocationCollection<Value> = {
  list(location?: V2LocationRef): readonly Value[] | undefined
  sync(location?: V2LocationRef): Promise<void>
  invalidate(location?: V2LocationRef): void
}

export type V2ResolvedTheme = {
  text: {
    default: unknown
    subdued: unknown
    feedback: Record<string, { default: unknown }>
    action: Record<string, Record<string, unknown>>
  }
  background: {
    default: unknown
    surface: { offset: unknown; overlay: unknown }
  }
  hue: Record<string, Record<string | number, unknown>>
  categorical?: ReadonlyArray<unknown>
}

export type V2TuiSetup = (context: V2TuiContext) => Promise<(() => void) | void> | (() => void) | void
