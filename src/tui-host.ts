/**
 * Host-agnostic TUI API surface consumed by the wizard (wizard.tsx) and by
 * embedding hosts (Config Studio). This is the exact bounded subset of the
 * OpenCode v1 `TuiPluginApi` the wizard uses; a v1 api instance satisfies it
 * structurally, and `v2-tui.ts` implements it over the OpenCode v2 TUI
 * plugin context. The wizard never touches anything outside this interface,
 * which is what lets one compiled wizard bundle run on both hosts.
 */

export type TuiDialogSelectOption<Value = string> = {
  title: string
  value: Value
  description?: string
  category?: string
  disabled?: boolean
}

export type TuiDialogSelectProps<Value = string> = {
  title: string
  placeholder?: string
  options: TuiDialogSelectOption<Value>[]
  current?: Value
  flat?: boolean
  onSelect: (option: TuiDialogSelectOption<Value>) => void
}

export type TuiDialogPromptProps = {
  title: string
  placeholder?: string
  value?: string
  onConfirm: (value: string) => void
  onCancel?: () => void
}

export type TuiDialogConfirmProps = {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel?: () => void
}

export type TuiDialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export type TuiHostTheme = {
  text: any
  textMuted: any
  background: any
  backgroundPanel: any
  primary: any
  secondary: any
  accent: any
  success: any
  warning: any
  error: any
  info: any
}

export type TuiHostKeyContext = {
  event?: {
    preventDefault?: () => void
    stopPropagation?: () => void
  }
}

export type TuiHostLayerCommand = {
  name: string
  title?: string
  desc?: string
  run: (ctx: TuiHostKeyContext) => void
}

export type TuiHostKeymapLayer = {
  mode?: string
  priority?: number
  commands: readonly TuiHostLayerCommand[]
  bindings: readonly { key: string; cmd: string; desc?: string }[]
}

/** Command descriptor shared with the palette-category registry. Carries both the v1 (`category`) and v2 (`group`) grouping fields. */
export type TuiHostPaletteCommand = {
  name: string
  title: string
  desc?: string
  category?: string
  group?: string
  run: () => void | Promise<void>
}

/** Minimal provider/model shape the wizard reads; the v1 SDK's richer Provider remains structurally assignable. */
export type TuiHostProvider = {
  id: string
  name: string
  models: Record<string, { id: string; name: string; variants?: Record<string, unknown> }>
}

export type TuiHostApi = {
  /** Host version marker (v2 adapter sets 2; v1 leaves undefined). */
  hostVersion?: 1 | 2
  app?: { version?: string }
  /** Raw host client (v1 SDK / v2 OpenCodeClient). Embedders feature-detect. */
  client?: unknown
  kv: {
    get<Value = unknown>(key: string, fallback?: Value): Value
    set(key: string, value: unknown): void
    readonly ready: boolean
  }
  lifecycle: {
    onDispose(fn: () => void): void
  }
  mode: {
    push(mode: string): () => void
  }
  renderer: {
    root?: any
  }
  state: {
    config: any
    provider: readonly TuiHostProvider[]
    path?: { config: string; directory: string; worktree: string }
  }
  /**
   * Dialog sizing scope. "standalone" (default): the wizard uses its OWN
   * size kv keys and offers the size editor. "embedded": the wizard reads
   * the embedding host's keys (Config Studio's ui-width/ui-height-percent)
   * and hides its size editor — the host's dialog settings rule.
   */
  dialogScope?: "standalone" | "embedded"
  theme: {
    readonly current: TuiHostTheme
  }
  ui: {
    toast(input: { variant?: string; title?: string; message: string; duration?: number }): void
    dialog: {
      replace(renderer: unknown, onClose?: () => void): void
      clear(): void
      setSize(size: string): void
    }
    DialogSelect<Value = string>(props: TuiDialogSelectProps<Value>): void
    DialogPrompt(props: TuiDialogPromptProps): void
    DialogConfirm(props: TuiDialogConfirmProps): void
    DialogAlert(props: TuiDialogAlertProps): void
  }
  keymap: {
    registerLayer(layer: TuiHostKeymapLayer): () => void
  }
}
