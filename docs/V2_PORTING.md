# Porting OpenCode Plugins from v1 to v2 (Dual-Target)

This is the Mirrowel playbook for making an OpenCode plugin run on **both
v1 and v2 from one npm package**, distilled from the agent-variants and
config-studio ports. It records every verified contract fact, every trap we
hit, and the testing strategy that caught regressions. **Keep it up to
date**: v2 is a beta and its plugin API is still settling — re-verify the
flagged facts (see [Keeping this guide current](#keeping-this-guide-current))
whenever the beta moves.

Living code references (read them alongside this guide):

| Concern | Implementation |
|---|---|
| Dual-target entries | `src/server.ts`, `src/tui.tsx` (agent-variants); `src/server.ts`, `src/tui.tsx` (config-studio) |
| v2 server (agent-transform routing) | `src/v2-server.ts` (agent-variants) |
| v2 server (composition + RPC) | `src/v2-server.ts` (config-studio) |
| v2 TUI adapter | `src/v2-tui.ts` (both repos — studio's is the richer variant) |
| Host-agnostic TUI interface | `src/tui-host.ts` (agent-variants) |
| Minimal hand-written v2 types | `src/v2-types.ts` (both repos) |
| Tests | `scripts/regression-tests.mjs` (agent-variants), `scripts/unit-tests.mjs` + `scripts/tui-startup-smoke.mjs` (config-studio) |

---

## 1. The ground truth sources

Never trust docs alone — including the official ones. Verify against source:

- **v1 source checkout**: `c:\tools\opencode` (published source; identifiers are
  minified but filenames, `.d.ts` files, and string literals are reliable).
  Published plugin package: `@opencode-ai/plugin@1.18.x`.
- **v2 source checkout**: `c:\tools\opencode-beta` (readable TypeScript,
  Effect 4). Upstream: `github.com/anomalyco/opencode`. The v2 CLI publishes as
  `@opencode-ai/cli` (bin **`opencode2`**, npm `beta` dist-tag) so it installs
  side by side with v1's `opencode`.
- **Official migration doc**: https://opencode.ai/v2/docs/migrate-v1/ — good
  orientation, sometimes stale; the request-param inertness below was correct
  there but we verified it in source anyway (and you should too).
- v2 in-repo docs worth reading: `packages/www/src/docs/content/build/plugins/`
  (server + cli plugin guides) and `packages/www/src/docs/content/agents.mdx`.

Version facts current at port time: v1 host = 1.18.27; v2 beta packages ≈
1.18.4; v1 hosts `@opentui/solid 0.4.5 + solid-js 1.9.12`, v2 hosts
`@opentui/solid 0.5.10 + solid-js 1.9.15`.

---

## 2. Mental model: what actually changed

| Area | v1 | v2 | Consequence |
|---|---|---|---|
| Plugin declaration | `plugin` array in `opencode.json(c)` (string \| `[spec, options]`), `tui.json` for TUI | `plugins` array (string \| `{package, options}`); v1 entries auto-migrate; one global `~/.config/opencode/cli.json` replaces layered `tui.json` | Parse both keys, all three entry forms |
| Server module contract | default `{ id, server }`, `server(input)` returns a hooks object | default `{ id, setup }`; `setup(ctx)` per location registers transforms/hooks imperatively, returns cleanup; **excess keys on default are ignored by BOTH loaders** | One default export serves both (§3) |
| TUI module contract | default `{ id, tui }`, `tui(api, options, meta)` | default `{ id, setup }` (hand-checked: only `id` non-empty string + `setup` function); **excess keys ignored** | Same trick works (§3) |
| Config contribution | `config(cfg)` hook mutates merged config once at startup | `ctx.<domain>.transform(editor => …)` — replayable, per-location; `ctx.<domain>.reload()` replays | Structural changes can go LIVE on v2 |
| Task tool | `task` with `subagent_type` | `subagent` with `agent`; child model = `agent.model ?? parent.model`; `mode:"primary"` rejected; hidden agents excluded from the model-visible list but callable | Route via agent definitions (§5.3) |
| Per-request model override | `chat.message` sets message.model | **Gone.** `session.context.model` is readonly | Clone agents carry the model (§5.3) |
| Per-request params/prompt | `chat.params`, `experimental.chat.system.transform`, `experimental.chat.messages.transform` | All unified into `session.context` (mutable `system: SystemPart[]`, `messages`, `generation`, `providerOptions`) | One hook, keyed by `event.agent` (§5.4) |
| Agent `request.body` | Applied via config | **Preserved but INERT on the wire** in current v2 (docs + source verified: read in zero request-path locations) | Apply params via `session.context`; copy parent `request` onto clones anyway (future-proofs the day v2 honors it) |
| Server→UI toasts | `client.tui.showToast` | **Removed** — no server-side notification path | Compute diagnostics TUI-side (§6.6) or degrade to log |
| Part repair | per-part SDK PATCH | whole-content `PATCH /api/session/:id/message/:msgID` (completed+idle only); **not exposed on the plugin ctx** | Stored input is persisted pre-hook (§5.5) so most repair becomes unnecessary |
| TUI dialogs | component-style (`DialogSelect(props)` returns JSX inside `dialog.replace(render)`) | promise-based (`ctx.ui.dialog.select/prompt/confirm/alert → Promise`) | Adapter bridge required (§6.3) |
| TUI storage | `api.kv` sync get/set (one kv.json) | `ctx.storage.store(key, {initial}) → [Store, async mutate]` per-key JSON files | Sync mirror (§6.4) |
| Palette/slash commands | `keymap.registerLayer({commands:[{namespace:"palette", name, title, desc, category, slashName, run}]})` | `ctx.keymap.layer(() => ({mode:"global", commands:[{id, title, description, group, palette:true, slash:{name}, bind, run}]}))` — reactive input fn | Convert at the adapter (§6.5) |
| Client SDK | v1 `OpencodeClient` (injected, `sdk/v2` gen for TUI) | `OpenCodeClient` from `@opencode-ai/client`; flat namespaces; `location` **query** param; envelopes differ per endpoint (§7) | Wrap/normalize (§7) |
| Tool registry API | `client.tool.list/ids` | **No HTTP API at all** | Plugin-RPC workaround (§8) |
| npm plugin cache | `~/.cache/opencode/packages/<sanitize(name)>` (early-return: reinstall skipped while `node_modules/<name>` exists) | `~/.cache/opencode/npm/<sanitize(name@spec)>/<generation>/` (Arborist generations, last 2 kept, background installs) | Standalone-resolution code needs both layouts (§9) |
| Serve (headless) | `opencode serve`, no auth | `opencode2 serve` — Basic auth (`opencode` + `OPENCODE_PASSWORD`), routes under `/api`, prompts are durable admissions + `wait` | Sink/spawn code branches per host (§10) |

---

## 3. The dual-target entry trick (verified)

**Server** (`dist/server.js`):

```ts
import plugin from "./index.js"          // v1 factory, untouched
import { createV2ServerSetup } from "./v2-server.js"

export default {
  id: "my-plugin",
  server: plugin,          // v1 reads this, then type-checks `tui` (absent → fine)
  setup: createV2ServerSetup(),  // v2 reads this; Effect Schema ignores excess `server`
}
```

**TUI** (`dist/tui.js`):

```ts
export default { id: "my-plugin", tui, setup: createV2TuiSetup() }
```

Why this is safe — the exact validation orders (verify in source when v2
updates):

- **v1 server** (`packages/opencode/src/plugin/shared.ts` `readV1Plugin`,
  detect mode): default must be a record → reads `value.server` → reads
  `value.tui` → type-checks both → **throws if BOTH `server` and `tui` are
  present** → invokes `server(input, options)`. Excess keys (like `setup`)
  are never inspected. So: never put a `tui` key on the **server** module.
- **v1 TUI** (strict mode, `packages/opencode/src/plugin/tui/runtime.ts`):
  default record + `tui` function required; excess keys ignored.
- **v2 server** (`packages/core/src/plugin/module.ts`): imports
  `exports["./server"]` (or package root), decodes `mod.default` as
  `{id, effect|setup}` — Effect Schema struct decode **ignores excess
  properties**, so the v1 `server` key rides along harmlessly.
- **v2 TUI** (`packages/tui/src/plugin/context.tsx` `isPlugin`): hand-written
  check for `id` non-empty string + `setup` function only; excess ignored.
- **TUI detection**: v2 decides a package has a TUI purely from
  `exports["./tui"]` being resolvable (recorded as `features.tui`), then the
  TUI process loads that same module and runs `setup`. No manifest key
  needed. (`"oc-plugin"` in package.json is documentation only — **neither
  host reads it**; keep or drop, irrelevant.)

**Do not** import `@opencode-ai/plugin` at runtime in v2 code paths:
`Plugin.define` is an identity function, and the npm-resolved package is
v1-shaped. Type-only imports are fine. Hand-write minimal context types in
`src/v2-types.ts` (copy from either repo) instead of depending on beta-only
package exports.

---

## 4. Plugin discovery, options, lifecycle (v2)

- Declared in `plugins` arrays of config documents + one global
  `cli.json` (TUI-only registrations) + auto-discovered from
  `<config>/plugins/*` and `<project>/.opencode/plugins/*` directories.
- Local targets must be **directories** (`file://` converted); relative
  paths resolve against the declaring config file. `-spec` entries disable.
- Options: `{package, options}` object form; reach `setup` as `ctx.options`.
- `setup(ctx)` runs **per location** (directory+workspace) at boot; the
  returned cleanup runs on plugin removal/reload. Plugin scope disposes all
  registrations made during setup.
- **The v2 TUI auto-loads TUI plugins that the server declared** (features.tui).
  v1's "self-wire into tui.json" pattern is therefore a **no-op on v2** —
  guard it by host version.
- Reload semantics: prefix-diff hot reload (unchanged plugins stay alive),
  `?mtime=` import cache-busting, last-good-generation retention.

---

## 5. Server-side port

### 5.1 The v2 context (promise flavor)

Domains (`packages/plugin/src/promise/`): `agent`, `catalog`, `command`,
`integration`, `mcp`, `reference`, `skill`, `tool`, `vcs`, `websearch`,
`worktree` (transforms + `reload()` each); `session`, `permission`, `shell`,
`aisdk` (hooks); `event.subscribe`, `storage` (KV), `rpc`, `generate`.
Hook callbacks run sequentially in registration order, mutating the event
object in place; return values are ignored. Promise-side hooks cannot reject
(effect-side `tool.execute.before` can, with `Tool.Error`).

### 5.2 Complete v1→v2 hook map

| v1 hook | v2 equivalent | Notes |
|---|---|---|
| `config(cfg)` | `ctx.agent.transform` (+ other domain transforms) | `editor.update(id, fn)` **upserts** (missing ids created from `Agent.default(id)`: mode **"primary"**, permissive permissions — set `mode:"subagent"` explicitly!); `editor.get/list/default/remove`; transforms replay on `reload()` |
| `tool.execute.before` | `ctx.tool.hook("execute.before", …)` | `{tool, sessionID, agent, messageID, id: callID, input}` — mutate `input` (mutation-after-await is honored: host awaits the callback); guard on `event.tool === "subagent"` |
| `tool.execute.after` | `ctx.tool.hook("execute.after", …)` | completed → mutable `event.result {output?, content?, metadata?}`; error → `event.error` |
| `chat.message` | **NONE** | model is readonly in `session.context`; model selection is agent/session state |
| `chat.params` | `ctx.session.hook("context")` | mutate `event.generation` (`temperature`, `topP`, `maxTokens`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`, `stop` — starts **empty** each call) + `event.providerOptions` (starts empty) |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` | mutate `event.system: SystemPart[]` (core itself does `system.splice(1,0,…)`); runs for primary/compaction/generate kinds, not title |
| `experimental.chat.messages.transform` | `ctx.session.hook("context")` | mutate `event.messages` (affects the outgoing call only, never persisted history) |
| `chat.headers` / provider baseURL | `ctx.session.hook("model.request")` | mutable `baseURL`, `headers` |
| raw HTTP escape hatch | `ctx.session.hook("http.request"/"http.response")` | full web `Request`/`Response` |
| `event` | `ctx.event.subscribe()` | typed `OpenCodeEvent`s only (durable + ephemeral) |
| `shell.env` | `ctx.shell.hook("create.before")` | mutable command/cwd/timeout/shell/env |
| `permission.ask` (dead in v1) | `ctx.permission.hook("evaluate")` | mutable `effect`/`message` |
| `tool.definition` | inside `ctx.tool.transform` editor (`update(id, fn)`) | tool defs are registry state, not per-request |
| server toasts | **NONE** | see §6.6 |
| provider small_model | `ctx.catalog.transform` (`model.default.set`) or agent config | — |

### 5.3 The agent-transform routing pattern (replaces chat.message)

When v1 routed by rewriting `subagent_type` + patching the message model, v2
should instead make the **agent id itself the route**:

1. Register visible agents for every selectable entry via
   `editor.update(alias, a => { a.mode = "subagent"; … })` as **full copies
   of the parent** (system, permissions, steps, request, color). The subagent
   tool resolves `agent.model ?? parent.model` structurally — no correlation,
   no races.
2. For state that must vary **per session** (e.g. profiles), pre-register
   **hidden per-model clones** (`av:<alias>@<profile>`, `hidden: true` —
   excluded from the model-visible list, still callable) and rewrite
   `input.agent` in `execute.before` to the clone matching the current state.
3. Permissions assert fires on the *executing* agent id — copy the parent's
   ruleset onto clones so per-agent permission config keeps working. Note the
   semantic shift: v1 asserted the parent id; users with explicit
   allow/deny-by-agent-id lists may see different prompts for rewritten calls.
4. Conflict handling: check `editor.get(alias)` before writing (a fresh
   editor is built per replay; entries present at your replay are user/config
   agents) and emit diagnostics on collisions. Track in-replay duplicates in
   a local set.
5. Ordering inside one transform replay matters: patch parents first, then
   read `editor.get(parent)` fresh for clone bases (matches v1's config
   mutation order).

### 5.4 Per-request patching via `session.context`

- Key the hook by `event.agent` — for rewritten calls that's the **clone id**
  (a perfect route key; normalize `av:` parent-clones back to the parent for
  parent-level patches).
- `agent.request.body` is **inert** (§2) — apply temperature/top_p/options
  through `generation`/`providerOptions` on every request (the hook fires per
  step, which matches v1 `chat.params` cadence).
- System prompts: bake composed prompts into clone definitions when the
  parent has a **static** system (`agent.system !== undefined`); when the
  parent relies on the dynamic tool-aware default (`system === undefined`),
  leave the clone unset and patch `event.system[0]` at request time
  (`promptRuntime` pattern). For profile overlays that only change the
  prompt, recompute **from the stored parent base**, never from the already
  baked value (double-composition trap).
- Session context fires for **all** sessions; cheap-guard on your known agent
  id set first.
- Session lookups (`ctx.session.get({sessionID})`) are Effect IPC — always
  wrap with timeout + catch (rule: never await host calls unbounded), cache
  immutable facts (parentID links) forever and volatile facts (session model)
  with a ~10s TTL.

### 5.5 Stored input is the model's raw input (no scrubbing needed)

`session.tool.called` is published when the **model emits** the call
(`packages/core/src/session/runner/publish-llm-event.ts`), before
`Tool.execute` (and thus before `execute.before`) runs. Your `input.agent`
rewrite affects only the live execution; history replay shows the alias the
model chose. `state.metadata` (from `execute.after`'s `result.metadata`) is
model-invisible. The only model-visible tool fields are `{id, name, input}`.

### 5.6 Hot reload of sidecar/config files

v1 needed restarts for structural changes. On v2: register the transform so
its callback **re-reads your file on every replay**, then watch the file and
call `ctx.agent.reload()` (debounced ~300ms). Watch the **parent directory**
and filter by basename — `rename`-based atomic saves (write-temp+rename) go
stale on Linux if you watch the file inode directly. Attach an `error`
handler; fall back to `watchFile` polling. Side effects of this pattern:
add/remove of agents goes live; also re-derive any side tables (route maps)
inside the transform callback so they never go stale.

### 5.7 What has no v2 server equivalent

- Toasts/notifications (→ §6.6).
- `chat.message`-style message mutation (model readonly).
- Stored part repair via plugin ctx (whole-content message PATCH exists as
  HTTP only; the TUI-side client *can* do it if some UI-hygiene repair ever
  becomes necessary).
- The `config` hook's full-document mutation (use per-domain transforms).

---

## 6. TUI-side port

### 6.1 Architecture: adapter, not rewrite

Define a **host-agnostic interface** (`src/tui-host.ts`) covering exactly the
bounded API surface your dialogs use (state.config/state.provider/state.path,
kv, ui.dialog.{replace,clear,setSize}, ui.DialogSelect/Prompt/Confirm/Alert,
ui.toast, theme.current, keymap.registerLayer, mode.push, renderer.root,
lifecycle.onDispose, client). The v1 api satisfies it structurally (wizard
code keeps working unchanged — the import swap is type-only); implement it
over the v2 context in `src/v2-tui.ts`. This is the single highest-leverage
decision: one compiled wizard bundle, two hosts.

### 6.2 The v2 TUI context

`{options, location, app, renderer, client, data (reactive location stores:
agent/provider/model/command/…), attention, theme, themeMode, markdown,
keymap, storage, ui}`. Commands with `palette: true`/`slash` **require** `id`.
`keymap.layer(input)` takes a **reactive** function — the layer re-evaluates
when signals read inside it change. Registrations auto-dispose at plugin
deactivate; there is **no per-layer unregister**.

### 6.3 Dialog bridge (the trap that cost us a blocker)

v1 flow: `api.ui.dialog.replace(() => api.ui.DialogSelect(props), onCancel)`
— host renders the thunk; the component returns JSX **inside** that dialog
entry; esc closes the entry and fires `onCancel`.

v2 has only promise dialogs that open **their own** host entry — and the
host's dialog replace fires the outgoing entry's `onClose` first, so a naive
bridge (`DialogSelect` → `ctx.ui.dialog.select()` inside a `dialog.show`)
resolves every wizard promise as cancelled **at open time**.

Correct bridge (see `src/v2-tui.ts` in either repo):

```
replace(renderer, onClose):
  content = renderer()          // invoke the thunk SYNCHRONOUSLY
  if content is renderable → dialog.show(() => content, onClose)
  else (a DialogX bridge already opened the host dialog):
      park onClose; register no dialog entry

DialogSelect/Prompt/Confirm/Alert:
  promise resolves with a value → settleNested(false); forward to onConfirm/onSelect
  resolves undefined (esc)      → settleNested(true)  → fires the parked onClose
```

Recover the full **option object** for `onSelect` (v1 passes the option, not
the value) by matching `options.find(o => o.value === resolved)`. Forward
`disabled` on options (v2 supports it). `confirm()` semantics: `true` =
explicit yes, `false` = explicit no, `undefined` = esc/close — v1 collapses
false and undefined to `onCancel`, keep that. Double-cancel on esc (parked
onClose + props.onCancel) is fine: wizard flows are settle-guarded, and it
matches v1 behavior.

### 6.4 kv → storage

v1 kv is synchronous. v2 `storage.store(key, {initial})` gives a Solid store
+ **async** mutator (per-key JSON file, cross-process synced). Keep a local
mirror: `set` writes the mirror immediately (read-your-writes) and fires the
persist; `get` reads mirror → store → fallback. `storage.memory(key)` for
ephemeral state.

### 6.5 Keymap conversion

v1 layer `{priority, commands:[{name,title,desc,run(ctx)}], bindings:[{key,cmd,desc}]}`
→ v2 layer `{mode:"global", priority, commands:[{id:name, title, description:desc, bind:"k1,k2", run}]}`:

- Emit **named** commands (`id`): the host passes the key event to named
  commands (inline commands get none — your `blockKey`/preventDefault would
  die), and users can rebind them.
- Multiple keys per command: comma-joined `bind` string. Key grammar:
  `ctrl+alt+left`, comma = alternatives, `enter/esc/pgup/pgdn` aliases are
  expanded host-side; `<leader>` exists.
- v1 palette commands (`namespace:"palette"`) map to
  `{palette:true, slash:{name:slashName}, group:category}` — v2 uses `group`
  where v1 used `category` (our palette-category registry stamps **both**).
- "Unregistering": flip a `createSignal(false)` read inside the layer input —
  reactivity makes the layer re-evaluate to `{enabled:false}`. The layer
  computation itself lives until host disposal (v2 has no unregister) — a
  disabled layer is inert; accept the tiny per-dialog-open accumulation.
- Wrap `run(input, event)` → `run({event})` defensively
  (`event.preventDefault?.()`).

### 6.6 Startup toasts without a server API

v2 diagnostics toasts: compute them **in the TUI plugin** at activation
(both processes have equivalent inputs — your config files + the shared
data stores / client) and fire `ctx.ui.toast.show`. The wizard's on-demand
diagnostics viewer needs no change; the server keeps a debug log.

### 6.7 state mirrors and theme

- `state.config`: v1 gave the merged config document. On v2 build it from
  `ctx.data.location.agent.list()` (resolved AgentInfo: name/mode/hidden/
  color/description/system — **filter `hidden`** or your own hidden clones
  become selectable parents!) plus `client.config.get({location})` docs for
  `default_agent` and plugin entries (docs are `ConfigEntry[]`; `type
  === "document"` → `info.plugins`/`info.plugin` entries in string | tuple |
  `{package}` forms; `info.mcp.servers` is the v2 MCP shape — invert
  `disabled`→`enabled` if you need the v1 form).
- `state.provider`: v2 providers are **flat** (no nested models). Compose the
  v1 shape by grouping `ctx.data.location.model.list()` by `providerID`
  (`modelID ?? id`, variants array → object keyed by variant id).
- Theme tokens (v1 → v2 `ResolvedTheme`): `text→text.default`,
  `textMuted→text.subdued`, `background→background.default`,
  `backgroundPanel→background.surface.offset`,
  `primary→text.action.primary.selected`,
  `accent→theme.hue.accent[dark?200:800]`,
  `success/warning/error/info→text.feedback.<k>.default`, `secondary` has no
  direct token (approximate a hue). Read `ctx.theme`/`ctx.themeMode` **inside
  the getter** — the host resolves a fresh token set on theme change.
- Fire `ctx.data.location.sync(ref)` (+ a config-docs refresh) once at
  activation and again when your command opens; stores may be `undefined`
  until synced.

### 6.8 Location wire format

The plugin-facing `LocationRef` is `{directory, workspaceID?}` but the wire
query wants `workspace`: translate at every direct client call boundary
(`{directory, workspace: ref.workspaceID}`); store APIs (`data.location.sync`)
take the ref form.

### 6.9 Build: OpenTUI 0.4/0.5 cross-compatibility

Both hosts inject their own `@opentui/solid` + `solid-js` at runtime (your
dist keeps them external; `packages:"external"` in the bun build). We
verified empirically (compile-with × render-under matrix, all 4 cells pass)
that 0.4.5-compiled and 0.5.10-compiled bundles each render under both host
runtimes for the primitive surface we use (`box/text/b/i`, refs, reactive
props, `For/Show`, `useTerminalDimensions`, `testRender`). Keep building
against the 0.4.x line + `solid-js 1.9.12` exact (satisfies npm peer ranges
of BOTH published opentui versions). If you add exotic OpenTUI APIs, extend
the matrix smoke first.

---

## 7. Client surface map (TUI-side)

v2 client = `@opencode-ai/client` `OpenCodeClient`, flat namespaces,
per-request `location` query (deepObject `?location[directory]=…`). Envelope
rules: endpoints with `Location.response` return `{location, data}` **not
unwrapped** (`provider.list`, `model.list`, `mcp.list`, `agent.list`,
`plugin.list`); plain `{data}` successes are auto-unwrapped by the SDK
(`session.*`). Don't double-unwrap.

| v1 call | v2 equivalent | Output |
|---|---|---|
| `provider.list()` (full catalog) | `provider.list` + `model.list` + `model.default` (compose) | `{location, data: Provider.Info[]}` / `Model.Info[]` / `ModelInfo\|null` |
| `config.providers()` | none — use `config.get` docs or composed `provider.list` | — |
| `session.active()` | `session.active()` | unwrapped `Record<id, {type:"running"}>` (narrower: this process's drains) |
| `session.status()` | none — events (`session.status`) or `session.active` | — |
| `session.get({sessionID})` | same name (flat args, no path) | unwrapped `Session.Info` |
| `session.wait({sessionID})` | same — POST, no body, 204 on idle | void (true long-poll) |
| `global.dispose()` / `instance.dispose()` | `client.debug.location.evict({location})` (DELETE /api/debug/location) — re-boots the location's cached services; config edits otherwise auto-reload (file watchers + `config.updated`) | 204 |
| `mcp.status()` | `mcp.list({location})` | `{location, data: Server[]}` with `status:{status:"connected"\|"pending"\|"disabled"\|"failed"\|"needs_auth", error?}` |
| `tool.list/ids` | **none** — see §8 | — |
| `config.get()` | same | `ConfigEntry[]` (no envelope) |
| `agent.list({location})` | same | `{location, data: Agent.Info[]}` |
| — | `plugin.list` / `plugin.update({targets})` | inventory / reload |

---

## 8. Tool registry access (the RPC workaround)

v2 has **no HTTP route for the tool registry** — it is server-internal
(`Tool.Service`). The sanctioned escape is a plugin RPC, registered in your
v2 **server** setup and called from the TUI:

```ts
// server: keep a snapshot fresh by replaying it inside a tool transform
let snapshot = []
await ctx.tool.transform((editor) => {
  snapshot = editor.list().map((t) => ({ id: t.id, description: t.description,
    parameters: wireSafeInputSchema(t.input) }))   // see below!
})
await ctx.rpc.register(
  { id: "my-plugin", methods: { tools: { input: {type:"object"}, output: {type:"object"} } }, events: {} },
  { tools: async () => ({ tools: snapshot }) },
)

// TUI: client.rpc.call({ rpcID: "my-plugin", method: "tools", input: {}, location })
//      POST /api/rpc/:rpcID/:method, body {input}, response {output}
```

Verified: plain JSON-Schema objects are accepted as portable value schemas
(core parses them via `fromJsonSchemaDocument`; nothing requires Standard
Schema). **Trap:** tool `input` schemas arrive as live Effect codecs or
Standard Schema objects — shipping those through the RPC serializes garbage.
Only pass through plain-JSON-looking schemas (`type`/`properties`/`$schema`
present) after a `JSON.parse(JSON.stringify())` deep clone; omit otherwise
(degrade to descriptions, like a v1 ids-only fallback).

---

## 9. npm cache layouts (standalone resolution, dev tooling)

- **v1**: `~/.cache/opencode/packages/<sanitize(name)>/node_modules/<name>`,
  early-return cache (existing install is never refreshed in place).
- **v2**: `~/.cache/opencode/npm/<sanitize(name@spec)>/<generation>/` where
  generation is a number (max wins; last 2 retained; update checks only for
  mutable specs). Installs land in `<gen>/node_modules/<name>`; a wrapper
  `package.json` sits at the gen root — unwrap via
  `node_modules/<scoped-name>` when the dir isn't the package itself.
- v2 honors `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` for
  global roots — compute yours the same way (see
  `v2GlobalConfigDir()` / `v2CacheRoot()` in the studio).
- Resolution order for "find the standalone install": v1 base first, then v2
  (key forms: exact `<name@spec>` and `<name>@latest`, then scan for keys
  containing the package name).

---

## 10. Headless serve (sinks, probes, spawn helpers)

- Binary: `opencode2` (npm package `@opencode-ai/cli`). Prefer `.exe` over
  `.cmd` shims when scanning PATH, and on Windows **spawn `.cmd/.bat` via
  `cmd.exe /c <shim>`** — Node ≥ 18.20 refuses direct `.cmd` spawn (EINVAL).
- Env: `OPENCODE_PASSWORD=<pw>` (v2 requires auth). Banner is still
  `server listening on <url>`. `OPENCODE_CONFIG_CONTENT` (inline config) and
  `OPENCODE_DISABLE_PROJECT_CONFIG` still work. **v1-syntax inline config
  keeps working on v2** — it is normalized in memory without rewriting.
- Routes: `/api/...`. Auth header: `Authorization: Basic
  base64("opencode:" + pw)` (username must be exactly `opencode`).
- Session flow: `POST /api/session` with `{agent, model: {id, providerID,
  variant?}, location?}` — **`id`, not `modelID`, and `variant` lives inside
  the ref** (a top-level `variant` is silently dropped — the A/B capture
  would compare identical bodies). Prompt: `POST /api/session/:id/prompt`
  with `{text}` — it's an **admission**, not a synchronous completion; then
  `POST /api/session/:id/wait` (long-poll to idle), then
  `DELETE /api/session/:id`. Event stream `GET /api/event` (SSE) and the
  durable per-session log `GET /api/experimental/session/:id/log?after&follow`
  for progress.
- Models: `Model.Ref` on the wire is `{providerID, id, variant?}`; note some
  create payloads document `modelID` — always verify against
  `packages/protocol/src/groups/session.ts` for the endpoint you use.

---

## 11. Config-file landscape

- v2 reads the same global/project config locations as v1; **v1-syntax files
  keep working** (normalized in memory, source never rewritten; v1/v2 fields
  may coexist at the top level). Editing v1-syntax files remains valid —
  the studio's Q4 decision — while unknown v2-native keys must be preserved
  by the JSONC edit engine (ours only touches edited paths).
- Key renames to be *aware of* (read-side): `agent`→`agents`
  (`prompt`→`system`, `disable`→`disabled`, `temperature/top_p/options`→
  `request.body`, `variant` joins model as `provider/model#variant`),
  `provider`→`providers` (`npm`→`package` with `aisdk:` prefix,
  `options.baseURL`→`settings.baseURL`), `command`→`commands`
  (`subtask`→`subagent`), permissions → ordered `permissions` array
  (`bash`→`shell`, `task`→`subagent`, `write|patch`→`edit`),
  `plugin`→`plugins`.
- Terminal-client config: one global `~/.config/opencode/cli.json`
  (`$schema https://opencode.ai/v2/cli.json`, `plugins`, `keybinds` keyed by
  command id); global `tui.json` auto-migrates on first v2 TUI start;
  project-local client config is NOT migrated. Editing `tui.json` under a v2
  host is inert — surface an explicit notice rather than silently writing a
  dead file.

---

## 12. Testing strategy

1. **Dual-validator tests** (node, cheap): import the built `dist/server.js`
   and `dist/tui.js`; assert the exact properties each real loader checks
   (v1 detect: `server` fn + no `tui` key on the server module; v1 strict:
   `tui` fn + no `server` key on the tui module; v2: `id` non-empty +
   `setup` fn; both ignore excess). Keep them inlined in the regression
   suite so they run on every build.
2. **Stub-editor tests** for transform logic: implement the v2 editor
   (`get/list/update/default/remove` over a Map; `update` upserts from the
   v2 default-agent shape) and unit-test your assembly, route resolution,
   and request-override application as pure functions. This caught more real
   bugs than anything else.
3. **OpenTUI matrix smoke** whenever the build toolchain or opentui versions
   move: compile a fixture with each candidate version, render under each
   runtime (all four cells).
4. **Feature-detected client code** stays testable against mock servers
   (envelope shapes both ways).
5. **Live acceptance** on both hosts (the only true oracle for host-runtime
   behavior — module resolution/aliasing of externals, dialog timing,
   keymap dispatch): register via `file://` dir spec (v1 `plugin`, v2
   `plugins`), run the TUI, exercise command + flows, check debug logs.

---

## 13. Known v2 platform gaps (as of the port)

Re-verify these whenever the beta updates — each is a candidate to
disappear:

- `agents.<id>.request` overlays inert on the wire (params must go through
  `session.context`; keep copying parent `request` onto clones so the day it
  activates, clones inherit correctly).
- No tool-registry HTTP API (RPC workaround, §8).
- No server→UI notifications.
- No per-layer keymap unregister (signal-disable only).
- `session.context.model` readonly (clone-agent routing, §5.3).
- Whole-content message repair is HTTP-only (not on the plugin ctx).
- Palette cross-plugin category joins can freeze on v2: layer inputs are
  only re-evaluated reactively, and the registry mutates plain objects —
  first-open label is right, late sibling joins may not propagate until the
  layer re-evaluates for another reason.

---

## 14. Port checklist (order of operations)

1. Read §1–§2; skim your plugin's host-API touchpoints (grep imports from
   `@opencode-ai/plugin`, hook keys, `client.*`, `api.*`).
2. Add `src/v2-types.ts` (copy from an existing repo) and the dual entries
   (§3). Add dual-validator tests. `ci` must stay green — at this point the
   v2 path is inert but the package already loads on both hosts.
3. Port the server: config contribution → domain transform; per-request
   patching → `session.context`; task interception → `execute.before/after`
   (§5). Extract pure functions + stub-editor tests as you go.
4. Define `tui-host.ts` (or reuse), swap the wizard's type import (type-only
   change), build the v2 adapter (§6), wire the setup.
5. Port client calls through a wrapper if your TUI probes the client (§7);
   add the tool RPC if you need the registry (§8).
6. Branch any spawn/serve tooling per host version (§10) and any cache/path
   resolution (§9, §11).
7. Full `ci:package` on the repo; heavy-review pass with a second model
   against the beta source (both reviews here found a blocker each).
8. Live acceptance on v1 (regression: nothing changed) and v2 (the new
   path).
9. Update this guide with whatever changed.

---

## 15. Keeping this guide current

When the v2 beta moves, re-verify in `c:\tools\opencode-beta` (pull first):

- Loader contracts: `packages/core/src/plugin/module.ts`,
  `packages/tui/src/plugin/context.tsx` (`isPlugin`),
  `packages/opencode/src/plugin/shared.ts` (v1 side, unlikely to move).
- Hook surface: `packages/plugin/src/promise/*.ts` (domains/hooks/types).
- Request assembly: `packages/core/src/session/model-request.ts` (what
  `session.context` may mutate; whether `agent.request` became live — search
  for consumers of `agent.request`/`Agent.Info.request`).
- Subagent tool: `packages/core/src/tool/plugin/subagent.ts` (input schema,
  model resolution, permission assert, list construction).
- Client/protocol: `packages/protocol/src/groups/*.ts`,
  `packages/client/src/promise/generated/client.ts` (method names, envelope
  rules, `location` query shape).
- TUI plugin API: `packages/plugin/src/tui/context.ts`,
  `packages/tui/src/plugin/api.tsx`, `packages/tui/src/context/keymap.tsx`.
- Serve/auth: `packages/cli/src/server-process.ts`, `packages/server/src/auth.ts`.
- Docs for orientation: `packages/www/src/docs/content/**` — treat as
  hints, confirm in source.

Update §13 (platform gaps) and the §2 table in the same commit as any port
change; the guide lives or dies by staying in sync with the checkouts.
