# Architecture

## Pattern Overview

**Overall:** OpenCode plugin with server-side hook routing and TUI wizard UI

**Key Characteristics:**
- Dual-entry plugin architecture: server hooks for runtime routing + TUI for configuration
- Sidecar config file (`agent-variants.jsonc`) separate from OpenCode's own config
- Marker-based token routing: variant calls embed HTML-comment tokens in prompts to correlate sessions
- Hot-reload boundary: runtime fields (model, prompt, temperature) apply per-call; structural fields (description, color, name) require restart
- Automatic config backups with patch-chain reversal on every save

## Layers

**Server Plugin (Hook Layer):**
- Purpose: Intercepts OpenCode lifecycle hooks to inject agent variants into the task tool and route model/parameter overrides
- Location: `src/index.ts`
- Contains: Plugin factory, route assembly, marker injection, session correlation, request patching
- Depends on: `src/config.ts` for config loading, validation, and model resolution
- Used by: OpenCode runtime via `src/server.ts` entry point

**Config & Schema Layer:**
- Purpose: Defines Zod schemas for sidecar config, backup journal, and patches; loads/saves JSONC config; validates model references
- Location: `src/config.ts`
- Contains: Zod schemas (`SidecarConfig`, `Patch`, `Variant`, `ModelShortcut`, `BackupJournal`), config I/O, model catalog builder, diagnostics engine, template rendering
- Depends on: `zod`, `comment-json`, `node:crypto`, `node:fs`, `node:path`, `node:os`
- Used by: `src/index.ts` and `src/tui.tsx`

**TUI Plugin (Wizard UI):**
- Purpose: Interactive terminal UI for creating, editing, and managing agent variants and model presets
- Location: `src/tui.tsx`
- Contains: Solid JSX components for menus, field editors, backup browser, diagnostics viewer; dialog orchestration loops
- Depends on: `src/config.ts`, `@opencode-ai/plugin/tui`, `@opentui/solid`, `solid-js`
- Used by: OpenCode TUI runtime via the `"tui"` export in `package.json`

**Build Output:**
- Purpose: Compiled JavaScript and type declarations for distribution
- Location: `dist/`
- Contains: `index.js`, `server.js`, `config.js`, `tui.d.ts`, `server.d.ts`, `index.d.ts`, `config.d.ts`
- Depends on: TypeScript compilation from `src/`
- Used by: npm package consumers

## Data Flow

**Config Assembly (Startup):**

1. OpenCode loads plugin via `src/server.ts` — `src/server.ts`
2. `loadSidecar()` reads `~/.config/opencode/agent-variants.jsonc` — `src/config.ts`
3. `assembleAgents()` merges parent patches, variant patches, model presets, and generated selection-guidance descriptions into `cfg.agent` entries — `src/index.ts`
4. Parent descriptions get a small appended alias nudge when variants exist — `src/index.ts`
5. Generated aliases are registered as virtual routes with token-based routing (built-ins) or cloned agents (custom agents) — `src/index.ts`
6. Diagnostics are emitted as toast warnings for invalid model references, conflicts, or disabled parents — `src/index.ts`

**Variant Call Routing (Runtime):**

1. `tool.execute.before` hook intercepts `task` tool calls targeting a variant alias — `src/index.ts`
2. `liveRoute()` re-validates the variant against current sidecar config (hot reload) — `src/index.ts`
3. A UUID token is generated and embedded as an HTML comment marker in the prompt — `src/index.ts`
4. `subagent_type` is rewritten to the parent agent so OpenCode routes to the correct agent — `src/index.ts`
5. `chat.message` hook extracts the marker from the response to correlate session → route — `src/index.ts`
6. `applyMessageModel()` sets the provider/model/variant on the response message — `src/index.ts`
7. `chat.params` hook patches temperature, top_p, and options on API requests — `src/index.ts`
8. `experimental.chat.system.transform` hook patches the system prompt with variant prepend/append — `src/index.ts`
9. `tool.execute.after` hook annotates task output with variant metadata — `src/index.ts`

**Wizard Config Editing:**

1. User invokes `Agent Variants: Configure` command from palette or slash command — `src/tui.tsx`
2. `mainMenu()` loop presents wizard options (add, edit, delete, presets, diagnostics, etc.) — `src/tui.tsx`
3. Config mutations happen in-memory via `structuredClone()` copies — `src/tui.tsx`
4. `saveConfig()` writes to sidecar file via `saveSidecar()` with automatic backup creation — `src/tui.tsx`, `src/config.ts`

**Config Backup System:**

1. `saveSidecar()` diffs previous vs. next config and writes a reverse-patch to the backup journal — `src/config.ts`
2. Full snapshots are created manually or before restores — `src/config.ts`
3. Restore walks the patch chain backward, validating hashes at each step — `src/config.ts`

## Key Abstractions

**AgentPatch:**
- Purpose: Represents a set of field overrides (model, variant, temperature, top_p, prompt, description, options, color) applied to a parent or variant
- Location: `src/config.ts` (Zod `Patch` schema)
- Pattern: Immutable data object validated by Zod, applied via `applyPatch()` / `applyConfigPatch()`

**RuntimeRoute:**
- Purpose: Tracks a resolved variant alias with its parent agent, target agent, effective model, and patch data at runtime
- Location: `src/index.ts`
- Pattern: In-memory lookup object stored in `virtualRoutes`, `pending`, `bySession`, and `byCall` maps

**SidecarConfig:**
- Purpose: The top-level configuration schema for the plugin, containing agents, model presets, UI settings, and debug flag
- Location: `src/config.ts` (Zod `SidecarConfig` schema)
- Pattern: Zod-validated JSONC config loaded from `~/.config/opencode/agent-variants.jsonc`

**ModelShortcut:**
- Purpose: Named preset for model, variant, temperature, top_p, and options; referenced by key in patch `model` fields
- Location: `src/config.ts` (Zod `ModelShortcut` schema)
- Pattern: Lookup table in `SidecarConfig.models`; resolved via `resolveModel()` and `applyModelPresetPatch()`

**SelectionPreset:**
- Purpose: Built-in task-list guidance presets that make variants easier for the main model to choose correctly, especially light/heavy/verification/parallel variants
- Location: `src/config.ts` (`SELECTION_PRESETS`, `inferredSelectionPreset()`, `generatedVariantDescription()`)
- Pattern: Auto-inference from key/name/model/model-variant when `description` is unset; the wizard can also materialize preset text into the Description field

**BackupJournal:**
- Purpose: Tracks config change history with reverse-patch operations and full snapshots for rollback
- Location: `src/config.ts` (Zod `BackupJournal` schema)
- Pattern: Append-only journal stored at `~/.config/opencode/agent-variants.backup.json`

## Entry Points

**Server Plugin:**
- Location: `src/server.ts`
- Triggers: OpenCode plugin loader reads `"server"` export from `package.json`
- Responsibilities: Exports plugin ID (`agent-variants`) and the server hook factory from `src/index.ts`

**TUI Plugin:**
- Location: `src/tui.tsx`
- Triggers: OpenCode TUI loader reads `"tui"` export from `package.json`
- Responsibilities: Registers the `agent-variants.configure` palette command; runs the interactive wizard loop

**Package Main:**
- Location: `dist/server.js` (via `package.json` `"main"`)
- Triggers: `import "@mirrowel/opencode-agent-variants"` or `import "@mirrowel/opencode-agent-variants/server"`
- Responsibilities: Same as server plugin entry, for programmatic use

## Error Handling

**Strategy:** Fail soft with diagnostic warnings

- Invalid model references are stripped from patches at assembly time; the variant is disabled with a warning toast
- Alias conflicts (duplicate names, parent name collision) skip the variant with an error toast
- Hot-reload validation (`liveRoute()`) throws errors that surface as task call failures
- Debug log writes are wrapped in try/catch to prevent I/O errors from affecting routing
- Config save uses atomic write (temp file + rename) to prevent corruption

## Cross-Cutting Concerns

**Logging:** Debug mode writes to `~/.config/opencode/agent-variants.debug.log` and shows toast notifications. Controlled by `sidecar.debug` flag or runtime toggle in wizard.

**Caching:** OpenCode caches the task list at startup. Structural changes (add/delete/disable variant, description, color) require restart. Runtime fields (model, prompt, temperature, top_p, options) hot-reload per call.

**Storage:** Sidecar config at `~/.config/opencode/agent-variants.jsonc`, backup journal at `~/.config/opencode/agent-variants.backup.json`, debug log at `~/.config/opencode/agent-variants.debug.log`.
