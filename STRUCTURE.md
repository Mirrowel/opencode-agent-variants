# Codebase Structure

## Directory Layout

```
agent-variants/
├── src/                      # Source code (TypeScript + TSX)
│   ├── server.ts             # Server plugin entry point
│   ├── index.ts              # Server plugin hook factory
│   ├── config.ts             # Config schemas, I/O, validation, diagnostics
│   └── tui.tsx               # TUI wizard (Solid JSX)
├── dist/                     # Compiled output (JS + .d.ts)
├── docs/                     # User-facing documentation
├── scripts/                  # Build/release helper scripts
├── .github/                  # CI workflows and release tooling
│   ├── workflows/            # GitHub Actions
│   └── scripts/              # CI helper scripts
├── .githooks/                # Git hooks (pre-commit)
├── package.json              # npm package definition and plugin exports
├── tsconfig.json             # TypeScript configuration
├── agent-variants.example.jsonc  # Example sidecar config
├── README.md                 # Project overview and usage guide
└── LICENSE                   # MIT license
```

## Directory Purposes

**`src/`:**
- Purpose: All application source code
- Contains: TypeScript modules (`.ts`) for server logic and config, plus a Solid JSX file (`.tsx`) for the TUI
- Key files: `server.ts`, `index.ts`, `config.ts`, `tui.tsx`

**`dist/`:**
- Purpose: Compiled JavaScript and type declaration output for npm distribution
- Contains: `.js` files (compiled from `src/*.ts`) and `.d.ts` type declarations
- Key files: `server.js`, `index.js`, `config.js`, `tui.d.ts`, `server.d.ts`, `index.d.ts`, `config.d.ts`
- Note: `tui.tsx` is served directly from source (listed in `package.json` `"files"`)

**`docs/`:**
- Purpose: User-facing documentation for configuration, releases, and plugin behavior
- Contains: Markdown guides
- Key files: `CONFIG.md`, `WALKTHROUGH.md`, `PLUGIN_DESCRIPTION.md`, `RELEASE.md`, `PLAN.md`

**`scripts/`:**
- Purpose: Build and release automation scripts
- Contains: Node.js ESM scripts (`.mjs`) for release management and git hook installation
- Key files: `release-lib.mjs`, `set-release-intent.mjs`, `check-release-intent.mjs`, `install-git-hooks.mjs`

**`.github/`:**
- Purpose: CI/CD automation
- Contains: GitHub Actions workflows and helper scripts for CI, release, and cleanup
- Key files: `workflows/ci.yml`, `workflows/release.yml`, `workflows/cleanup-releases.yml`, `scripts/generate-release-notes.sh`, `scripts/compute-version.sh`, `cliff.toml`

**`.githooks/`:**
- Purpose: Local git hooks for development
- Contains: `pre-commit` hook that runs `npm run commit:check`

## Key File Locations

**Entry Points:** `src/server.ts`: Server plugin entry (re-exports `src/index.ts` as `{ id, server }`); `src/tui.tsx`: TUI plugin entry (exports `{ id, tui }`)
**Configuration:** `tsconfig.json`: TypeScript compiler options (ES2022, NodeNext, JSX with Solid); `package.json`: npm package config with `"oc-plugin": ["server", "tui"]` manifest
**Core Logic:** `src/index.ts`: Hook factory with route assembly, marker injection, session correlation; `src/config.ts`: All schemas, config I/O, model resolution, backup system, diagnostics
**Config Example:** `agent-variants.example.jsonc`: Annotated example of the sidecar config format
**Tests:** No test files exist in this project currently
**CI/CD:** `.github/workflows/ci.yml`: Lint, typecheck, build, pack dry-run; `.github/workflows/release.yml`: Automated npm publish and GitHub release

## Naming Conventions

**Files:** `kebab-case` for all filenames: `release-lib.mjs`, `set-release-intent.mjs`, `check-release-intent.mjs`
**Source modules:** Singular nouns for domain modules: `config.ts`, `server.ts`, `index.ts`, `tui.tsx`
**Directories:** `kebab-case` or `camelCase` per ecosystem convention: `.github/`, `scripts/`, `docs/`

## Where to Add New Code

**New server hook:** Add the hook handler inside the plugin factory in `src/index.ts` — follow the existing `"tool.execute.before"` / `"chat.message"` pattern as a new key in the returned plugin object

**New config field:** Add the field to the `Patch` Zod schema in `src/config.ts`, add it to `PATCH_FIELDS` (and optionally `HOT_RELOAD_FIELDS`), then add handling in `applyPatch()` in `src/index.ts` and `EDITABLE_FIELDS` in `src/tui.tsx`

**New dialog/component:** Add a `show*()` dialog function and corresponding JSX component in `src/tui.tsx` — follow the `showMenu()` / `MenuDialog` or `showFieldList()` / `FieldListDialog` pattern

**New wizard flow:** Add a menu option in `mainMenu()` in `src/tui.tsx`, implement an async function that takes `(api, config, settings)` and returns the updated config

**New model preset field:** Add to the `ModelShortcut` Zod schema in `src/config.ts` and to `MODEL_PRESET_FIELDS` in `src/tui.tsx`

**New script:** Add to `scripts/` as `.mjs` — follow existing naming (`kebab-case.mjs`)

**Shared utilities:** Add to `src/config.ts` for config-related helpers; add to `src/index.ts` for routing-related helpers
