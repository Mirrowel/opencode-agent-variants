# Architecture

## Pattern Overview

**Overall:** OpenCode plugin with server-side hook routing and TUI wizard UI

**Key Characteristics:**
- Dual-entry plugin architecture: server hooks for runtime routing + TUI for configuration
- Sidecar config file (`agent-variants.jsonc`) separate from OpenCode's own config
- Markerless route correlation by default: child sessions are matched through OpenCode task metadata (`sessionId`) and task call IDs; legacy prompt markers are an opt-in debug fallback
- Hot-reload boundary: runtime fields (model, prompt, temperature) apply per-call; structural fields (description, color, name) require restart
- Two-phase model validation: shape (`provider/model` format) checks run synchronously at startup; provider/model existence checks run asynchronously once OpenCode's merged provider catalog is available, with diagnostic toasts delivered through a retry-capable queue
- Automatic config backups with patch-chain reversal on every save
- Internal-only routing metadata: route state stays in memory and task `state.metadata`; legacy markers and residual artifacts are stripped from model-visible output; stored task parts are auto-repaired when needed

## Layers

**Server Plugin (Hook Layer):**
- Purpose: Intercepts OpenCode lifecycle hooks to inject agent variants into the task tool and route model/parameter overrides
- Location: `src/index.ts`
- Contains: Plugin factory, route assembly, metadata/optional-marker session correlation, request patching, chat history sanitization
- Depends on: `src/config.ts` for config loading, validation, and model resolution
- Used by: OpenCode runtime via `src/server.ts` entry point

**Config & Schema Layer:**
- Purpose: Defines Zod schemas for sidecar config, backup journal, and patches; loads/saves JSONC config; validates model references
- Location: `src/config.ts`
- Contains: Zod schemas (`SidecarConfig`, `Patch`, `Variant`, `ModelShortcut`, `BackupJournal`), config I/O, model catalog builder, diagnostics engine, template rendering, selection presets
- Depends on: `zod`, `comment-json`, `node:crypto`, `node:fs`, `node:path`, `node:os`
- Used by: `src/index.ts` and `src/tui.tsx`

**TUI Plugin (Wizard UI):**
- Purpose: Interactive terminal UI for creating, editing, and managing agent variants and model presets
- Location: `src/tui.tsx`
- Contains: Solid JSX components for menus, field editors, backup browser, diagnostics viewer, selection preset picker; dialog orchestration loops
- Depends on: `src/config.ts`, `@opencode-ai/plugin/tui`, `@opentui/solid`, `solid-js`
- Used by: OpenCode TUI runtime via the compiled `dist/tui.js` target of the `"tui"` export in `package.json`

**Build Output:**
- Purpose: Compiled JavaScript and type declarations for distribution
- Location: `dist/`
- Contains: `index.js`, `server.js`, `config.js`, `tui.js`, `tui.d.ts`, `server.d.ts`, `index.d.ts`, `config.d.ts`
- Depends on: TypeScript compilation from `src/`, followed by a Bun/OpenTUI Solid compilation pass for `src/tui.tsx`; OpenTUI and Solid remain external host-provided runtime imports
- Used by: npm package consumers

## Data Flow

**Config Assembly (Startup):**

1. OpenCode loads plugin via `src/server.ts` — `src/server.ts`
2. `loadSidecar()` reads `~/.config/opencode/agent-variants.jsonc` — `src/config.ts`
3. `assembleAgents()` merges parent patches, variant patches, model presets, and auto-inferred selection-guidance descriptions into `cfg.agent` entries — `src/index.ts`, `src/config.ts`
4. Parent descriptions get appended variant alias list and selection guidance via `generatedParentDescription()` when variants exist — `src/index.ts`, `src/config.ts`
5. Generated aliases are registered as virtual routes with metadata-based routing (built-ins) or cloned agents (custom agents) — `src/index.ts`
6. Shape diagnostics (malformed `provider/model` references, conflicts, alias collisions, disabled entries) are emitted immediately; patches with shape errors have their model fields stripped — `src/index.ts`, `src/config.ts`
7. `refreshMergedCatalog()` asynchronously fetches OpenCode's merged provider catalog via `client.provider.list` (falling back to `client.config.providers`) with retry backoff, then runs existence validation against it — `src/index.ts`
8. `flushDiagnosticQueue()` delivers deferred diagnostics as warning toasts with retry support (toasts can be undeliverable before the TUI is ready) — `src/index.ts`

**Variant Call Routing (Runtime):**

1. `tool.execute.before` hook intercepts `task` tool calls targeting a variant alias — `src/index.ts`
2. `liveRoute()` re-validates the variant against current sidecar config (hot reload): shape validation always runs; existence validation runs only when the merged provider catalog is available — `src/index.ts`
3. A pending route is stored by task call ID; when `routing.prompt_markers` is enabled, a legacy HTML marker token is also injected as fallback — `src/index.ts`
4. `subagent_type` is rewritten to the parent agent so OpenCode routes to the correct agent — `src/index.ts`
5. `chat.message` correlates child session → parent task part via OpenCode task metadata (`state.metadata.sessionId`) and task call ID; legacy marker extraction remains as fallback — `src/index.ts`
6. `applyMessageModel()` sets the provider/model/variant on the response message — `src/index.ts`
7. `chat.params` hook patches temperature, top_p, and options on API requests — `src/index.ts`
8. `experimental.chat.system.transform` hook patches the system prompt with variant prepend/append — `src/index.ts`
9. `tool.execute.after` hook stores minimal internal metadata (`agentVariants.alias`, `agentVariants.routedAgent`) and scrubs all routing artifacts from task output — `src/index.ts`
10. `experimental.chat.messages.transform` strips route markers and routing metadata from replayed chat history before any model sees it; when stored task parts contain residual artifacts, they are repaired via the session message API with read-back verification — `src/index.ts`

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
- Purpose: Built-in task-list guidance presets that make variants easier for the main model to choose correctly
- Location: `src/config.ts` (`SELECTION_PRESETS`, `inferredSelectionPreset()`, `selectionPresetText()`, `generatedVariantBase()`)
- Pattern: 9 presets (basic, light, heavy, verification, parallel, strict-review, conservative, creative, synthesis) auto-inferred from variant key/name/model/model-variant; model-tier inference distinguishes entry-level/high-volume models (for example GPT nano and GPT-5.6 Luna), balanced models (GPT mini and GPT-5.6 Terra), and flagship models (GPT-5.5 and GPT-5.6 Sol); literal canonical tier words (`basic`, `light`, `heavy`) are explicit overrides, otherwise recognized model capability wins and semantic task names such as `data-entry` are fallback evidence only when the model tier is unknown; specialized purpose presets remain purpose-driven; the wizard can materialize preset text into the Description field or leave it auto-inferred

**ModelCatalog:**
- Purpose: Snapshot of OpenCode's merged provider/model/variant inventory used for existence validation
- Location: `src/config.ts` (type `ModelCatalog`, builder `modelCatalogFromProviders()`); fetched via `fetchMergedCatalog()` in `src/index.ts`
- Pattern: Built from `client.provider.list` (fallback `client.config.providers`); `undefined` until the async refresh resolves, so callers fall back to shape-only validation

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

- Malformed model references (shape errors) are stripped from patches at assembly time and the variant is skipped with an immediate warning toast; provider/model existence errors are reported asynchronously after the merged provider catalog is available, and invalid hot-reloaded variants fail before execution once the catalog is ready
- Alias conflicts (duplicate names, parent name collision) skip the variant with an error toast
- Hot-reload validation (`liveRoute()`) throws errors that surface as task call failures
- All host client interactions (session lookups, toast delivery, provider catalog fetches) run through `safeClientCall()` with an enforced timeout (3s) and swallowed errors so the plugin never blocks the host
- Debug log writes are wrapped in try/catch to prevent I/O errors from affecting routing
- Config save uses atomic write (temp file + rename) to prevent corruption

## Cross-Cutting Concerns

**Logging:** Debug mode writes to `~/.config/opencode/agent-variants.debug.log` and shows toast notifications only while enabled. Controlled by `sidecar.debug` flag or runtime toggle in wizard, and hot-read by server hooks.

**Caching:** OpenCode caches the task list at startup. Structural changes (add/delete/disable variant, description, color) require restart. Runtime fields (model, prompt, temperature, top_p, options) hot-reload per call.

**Storage:** Sidecar config at `~/.config/opencode/agent-variants.jsonc`, backup journal at `~/.config/opencode/agent-variants.backup.json`, debug log at `~/.config/opencode/agent-variants.debug.log`.
