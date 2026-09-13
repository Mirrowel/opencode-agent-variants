# Codebase Structure

## Directory Layout

```
agent-variants/
├── src/                      # Source code (TypeScript + TSX)
│   ├── server.ts             # Dual-target server entry (v1 server factory + v2 setup)
│   ├── index.ts              # v1 server plugin hook factory
│   ├── v2-server.ts          # v2 setup: agent-transform clone routing + live reload
│   ├── v2-types.ts           # Hand-written minimal v2 context types
│   ├── config.ts             # Config schemas, I/O, validation, diagnostics, profiles
│   ├── palette-category.ts   # Shared palette category registry for sibling Mirrowel plugins
│   ├── selfwire.ts           # v1 TUI self-wiring (mirror server registration into tui.json)
│   ├── tui.tsx               # Dual-target TUI plugin entry (v1 tui factory + v2 setup)
│   ├── v2-tui.ts             # v2 TUI adapter + setup (implements TuiHostApi)
│   ├── tui-host.ts           # Host-agnostic TuiHostApi interface the wizard targets
│   └── wizard.tsx            # TUI wizard library (Solid JSX) — dialogs, flows, embed exports
├── dist/                     # Compiled output (JS + .d.ts)
├── docs/                     # User-facing documentation
├── scripts/                  # Build/release helper scripts
├── .github/                  # CI workflows and release tooling
│   ├── workflows/            # GitHub Actions
│   └── scripts/              # CI helper scripts
├── .githooks/                # Git hooks (pre-commit)
├── package.json              # npm package definition and plugin exports
├── tsconfig.json             # TypeScript configuration
├── schema.json               # Generated JSON Schema for agent-variants.jsonc (from Zod)
├── agent-variants.example.jsonc  # Example sidecar config
├── README.md                 # Project overview and usage guide
└── LICENSE                   # MIT license
```

## Directory Purposes

**`src/`:**
- Purpose: All application source code
- Contains: TypeScript modules (`.ts`) for server logic, config, and palette category, plus Solid JSX files (`.tsx`) for the TUI entry and wizard library
- Key files: `server.ts` (dual-target entry: v1 `server` factory + v2 `setup`), `index.ts` (v1 server hooks — untouched by the v2 port), `v2-server.ts` (v2 setup: agent-transform clone routing, hidden profile clones, session.context request patching, sidecar live reload), `v2-types.ts` (hand-written minimal v2 context types), `v2-tui.ts` (v2 TUI adapter + setup), `tui-host.ts` (host-agnostic `TuiHostApi` the wizard targets; v1 api satisfies it structurally), `selfwire.ts` (v1-only `ensureTuiRegistration()` — mirrors the standalone server registration into a same-level `tui.json`; skips entirely when Config Studio is present), `config.ts`, `palette-category.ts`, `tui.tsx` (dual-target TUI entry), `wizard.tsx`

**`dist/`:**
- Purpose: Compiled JavaScript and type declaration output for npm distribution
- Contains: `.js` files (compiled from `src/*.ts` and `src/*.tsx`) and `.d.ts` type declarations
- Key files: `server.js`, `index.js`, `v2-server.js`, `config.js`, `palette-category.js`, `selfwire.js`, `tui.js`, `wizard.js`, `tui-host.js`, `v2-tui.js`, `v2-types.js`, plus matching `.d.ts` declarations
- Note: `src/` is also shipped for source inspection, but the runtime loads `dist/tui.js` and `dist/wizard.js`; `scripts/build-tui.mjs` compiles both `src/tui.tsx` and `src/wizard.tsx` with OpenTUI's Solid transform so reactive dialog properties repaint correctly from npm installs; `scripts/generate-schema.mjs` emits `schema.json` from the Zod `SidecarConfig` schema during build

**`docs/`:**
- Purpose: Documentation for configuration, releases, plugin behavior, and internal engineering playbooks
- Contains: Markdown guides
- Key files: `CONFIG.md` (user-facing, shipped in the npm package), `V2_PORTING.md` (internal playbook for dual OpenCode v1+v2 plugin ports — kept in sync with the v1/v2 source checkouts; NOT shipped), `WALKTHROUGH.md`, `PLUGIN_DESCRIPTION.md`, `RELEASE.md`, `PLAN.md`, `ALIAS_UNDERSTANDING_TEST.md`

**`scripts/`:**
- Purpose: Build, release, and verification automation scripts
- Contains: Node.js ESM scripts (`.mjs`) for release management, git hook installation, package-content verification, and regression testing
- Key files: `release-lib.mjs`, `set-release-intent.mjs`, `check-release-intent.mjs`, `install-git-hooks.mjs`, `build-tui.mjs`, `solid-tui-build.mjs`, `generate-schema.mjs`, `pack-dry-run.mjs`, `regression-tests.mjs`, `tui-reactivity-smoke.mjs`, `tui-package-smoke.mjs`

**`.github/`:**
- Purpose: CI/CD automation
- Contains: GitHub Actions workflows and helper scripts for CI, release, and cleanup
- Key files: `workflows/ci.yml`, `workflows/release.yml`, `workflows/cleanup-releases.yml`, `scripts/generate-release-notes.sh`, `scripts/compute-version.sh`, `cliff.toml`

**`.githooks/`:**
- Purpose: Local git hooks for development
- Contains: `pre-commit` hook that runs `npm run commit:check`

## Key File Locations

**Entry Points:** `src/server.ts`: Dual-target server entry (exports `{ id, server, setup }` — v1 `server` factory from `src/index.ts` plus v2 `setup` from `src/v2-server.ts`); `src/tui.tsx`: Dual-target TUI entry (exports `{ id, tui, setup }`, bootstraps `src/wizard.tsx`); `src/wizard.tsx`: embeddable wizard library (exposes `mainMenu`, dialogs, and `WizardHost` via the `"wizard"` export in `package.json`)
**Configuration:** `tsconfig.json`: TypeScript compiler options (ES2022, NodeNext, JSX with Solid); `package.json`: npm package config with the `"oc-plugin": ["server", "tui"]` manifest plus `"wizard"` (embedding hosts), `"tui-host"` (host-agnostic wizard API), and `"v2"` (v2 TUI adapter) exports; `schema.json`: generated JSON Schema for `agent-variants.jsonc` editor validation (regenerated by `scripts/generate-schema.mjs` during build)
**Core Logic:** `src/index.ts`: Hook factory with route assembly, fail-closed metadata-based session correlation (`correlateTaskRoute`), optional legacy prompt-marker fallback, profile overlay application; `src/config.ts`: All schemas, config I/O, model resolution, profiles, backup system, diagnostics; `src/palette-category.ts`: Process-wide palette category registry for sibling Mirrowel plugins
**Config Example:** `agent-variants.example.jsonc`: Annotated example of the sidecar config format
**Tests:** `scripts/regression-tests.mjs`: Node-based regression suite (no test runner) exercising the compiled `dist/` — dual-entry module shape, palette category registry, v2 agent assembly/profile clones/execution routing, partial provider overrides, deferred diagnostics, malformed model shape skipping, markerless routing and legacy marker scrubbing, fail-closed parallel base-task correlation, v2 correlation, runtime dependency metadata, selection tier inference, profile overlays, live/history repair never reverting running parts, selfwire registration, and embedded dialog scope; run via `npm run test:regression`
**CI/CD:** `.github/workflows/ci.yml`: Typecheck, build, regression tests, TUI reactivity smoke, pack dry-run, and TUI package smoke (run as a single `npm run ci` step, also gated locally by the pre-commit hook); `.github/workflows/release.yml`: Automated npm publish and GitHub release

## Naming Conventions

**Files:** `kebab-case` for all filenames: `release-lib.mjs`, `set-release-intent.mjs`, `check-release-intent.mjs`
**Source modules:** Singular nouns for domain modules: `config.ts`, `server.ts`, `index.ts`, `palette-category.ts`, `selfwire.ts`, `tui.tsx`, `wizard.tsx`; v2 modules prefix `v2-` (`v2-server.ts`, `v2-tui.ts`, `v2-types.ts`) and host-surface modules are descriptive (`tui-host.ts`)
**Directories:** `kebab-case` or `camelCase` per ecosystem convention: `.github/`, `scripts/`, `docs/`

## Where to Add New Code

**New server hook:** Add the hook handler inside the plugin factory in `src/index.ts` — follow the existing `"tool.execute.before"` / `"chat.message"` pattern as a new key in the returned plugin object

**New config field:** Add the field to the `Patch` Zod schema in `src/config.ts`, add it to `PATCH_FIELDS` (and optionally `HOT_RELOAD_FIELDS`), then add handling in `applyPatch()` in `src/index.ts` and `EDITABLE_FIELDS` in `src/wizard.tsx`

**New dialog/component:** Add a `show*()` dialog function and corresponding JSX component in `src/wizard.tsx` — follow the `showMenu()` / `MenuDialog` or `showFieldList()` / `FieldListDialog` pattern

**New wizard flow:** Add a menu option in `mainMenu()` in `src/wizard.tsx`, implement an async function that takes `(api, config, settings)` and returns the updated config

**New profile field:** Add to the `ProfilePatch` Zod schema in `src/config.ts` and to `PROFILE_FIELDS` (which mirrors `HOT_RELOAD_FIELDS`) — profile patches are hot-field only; the lens helpers in `src/config.ts` and editors in `src/wizard.tsx` pick up the field automatically

**New model preset field:** Add to the `ModelShortcut` Zod schema in `src/config.ts` and to `MODEL_PRESET_FIELDS` in `src/wizard.tsx`

**New script:** Add to `scripts/` as `.mjs` — follow existing naming (`kebab-case.mjs`)

**New regression test case:** Add a `function testX()` to `scripts/regression-tests.mjs` that drives `__testAssembleAgents` / `__testInternals` from `dist/`, then call it at the bottom of the file alongside the other `test*()` invocations — assertions throw on failure; the suite is run via `npm run test:regression`

**New v2 behavior:** Add server-side routing to `src/v2-server.ts` (register callbacks inside `createV2ServerSetup()`; extend `assembleV2Agents()` / `resolveExecutionAgent()` / `applyContextOverrides()`) and TUI adapter behavior to `src/v2-tui.ts` (`buildV2HostApi()` / `createV2TuiSetup()`); expose new v2 context surfaces in `src/v2-types.ts` and new wizard-facing host surfaces in `src/tui-host.ts`. Never import `@opencode-ai/plugin` from a `v2-*` module at runtime

**New self-wire rule:** Add to `src/selfwire.ts` — spec identity matching in `isAgentVariantsSpec()` / `isConfigStudioSpec()`, and layer discovery in `opencodeLayerPaths()` / `tuiLayerPaths()`

**Shared utilities:** Add to `src/config.ts` for config-related helpers; add to `src/index.ts` for routing-related helpers; add to `src/palette-category.ts` for palette/category integration shared across Mirrowel plugins
