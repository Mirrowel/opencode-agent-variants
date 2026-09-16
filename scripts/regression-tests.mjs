import { readFileSync } from "node:fs"
import { __testAssembleAgents, __testInternals } from "../dist/index.js"
import { emptyConfig, inferredSelectionPreset, SELECTION_PRESETS, SidecarConfig, profileMatchesModel, resolveActiveProfile, overlayProfilePatch, profileVariantPatch, profileParentPatch, profileFieldSource, setProfileFieldIn, buildUnknownTaskIdMessage, levenshteinWithin } from "../dist/config.js"
import { currentPaletteCategory, declarePaletteCategory, reconcilePaletteCategories, __resetPaletteRegistry } from "../dist/palette-category.js"
import { applyWizardUiSettings } from "../dist/wizard.js"
import { isAgentVariantsSpec, isConfigStudioSpec, ensureTuiRegistration } from "../dist/selfwire.js"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
const path = { join, sep }
import { pathToFileURL } from "node:url"
import * as serverEntry from "../dist/server.js"
import * as tuiEntry from "../dist/tui.js"
import { assembleV2Agents, applyContextOverrides, composeVariantPatch, parentCloneId, resolveExecutionAgent, variantCloneId } from "../dist/v2-server.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function hardDiagnostics(assembled) {
  return assembled.diagnostics.filter((item) => item.level === "error" || /skipped|not found|was not found/i.test(item.message))
}

function assertGenerated(assembled, cfg, alias) {
  assert(cfg.agent[alias], `${alias} should be generated`)
  assert(assembled.virtualRoutes.has(alias), `${alias} should have a runtime route`)
}

function testPaletteCategory() {
  __resetPaletteRegistry()

  // Single plugin declared: own name, applied to its command immediately.
  const avCommand = { category: "" }
  const first = declarePaletteCategory("Agent Variants", avCommand)
  assert(first === "Agent Variants", "lone declaration returns its own name")
  assert(avCommand.category === "Agent Variants", "lone declaration stamps its command")

  // Second plugin declares later: both commands mutate to the identical join.
  const studioCommand = { category: "" }
  const second = declarePaletteCategory("Config Studio", studioCommand)
  assert(second === "Agent Variants & Config Studio", "second declaration returns the join")
  assert(avCommand.category === "Agent Variants & Config Studio", "earlier command mutated to the join")
  assert(studioCommand.category === "Agent Variants & Config Studio", "new command stamped with the join")
  assert(currentPaletteCategory() === "Agent Variants & Config Studio", "live getter matches")

  // Third plugin: deterministic alphabetical three-way join everywhere.
  const soukCommand = { category: "" }
  declarePaletteCategory("Souk", soukCommand)
  const expected = "Agent Variants, Config Studio & Souk"
  assert(soukCommand.category === expected, "three-way join stamped")
  assert(avCommand.category === expected && studioCommand.category === expected, "all earlier commands mutated to the three-way join")

  // Duplicate declaration of a known label: no duplicate in the join.
  declarePaletteCategory("Agent Variants")
  assert(currentPaletteCategory() === expected, "duplicate label does not duplicate in the join")

  // Reconcile is idempotent and repairs stale categories (v1 `category`
  // field and the v2 `group` field stay in sync).
  avCommand.category = "stale"
  reconcilePaletteCategories()
  assert(avCommand.category === expected, "reconcile repairs stale categories")
  assert(avCommand.group === expected, "reconcile stamps the v2 group field")

  __resetPaletteRegistry()
  assert(currentPaletteCategory() === "", "reset clears the registry")
}

// ---------------------------------------------------------------------------
// OpenCode v2 dual-target surface
// ---------------------------------------------------------------------------

function testDualEntryModules() {
  // v2 server module validation: default must be {id, setup} — excess keys
  // (the v1 `server` factory) are ignored by the Effect Schema decode.
  const serverModule = serverEntry.default
  assert(typeof serverModule === "object" && serverModule !== null, "server entry default is a record")
  assert(serverModule.id === "agent-variants", "server entry carries the plugin id")
  assert(typeof serverModule.setup === "function", "server entry exposes a v2 setup function")

  // v1 server detect-mode validation (packages/opencode readV1Plugin, detect):
  // default record → reads .server (must be a function) → reads .tui (must be
  // undefined here) → the both-present rejection can never fire.
  assert(typeof serverModule.server === "function", "server entry exposes the v1 server factory")
  assert(serverModule.tui === undefined, "server entry must not advertise a tui export (v1 both-present rejection)")

  // v2 TUI validation (packages/tui isPlugin): id non-empty string + setup
  // function; excess `tui` ignored.
  const tuiModule = tuiEntry.default
  assert(typeof tuiModule === "object" && tuiModule !== null, "tui entry default is a record")
  assert(typeof tuiModule.id === "string" && tuiModule.id.length > 0, "tui entry carries a non-empty id")
  assert(typeof tuiModule.setup === "function", "tui entry exposes a v2 setup function")

  // v1 TUI strict-mode validation: default record + tui function required,
  // no server key (strict mode rejects a non-function server, and the
  // both-present rejection would fire if both existed).
  assert(typeof tuiModule.tui === "function", "tui entry exposes the v1 tui factory")
  assert(tuiModule.server === undefined, "tui entry must not carry a server export")
}

function stubV2Editor(agents) {
  const map = new Map()
  for (const [id, info] of Object.entries(agents ?? {})) map.set(id, structuredClone(info))
  const defaults = (id) => ({ id, name: id, request: { settings: {}, headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] })
  return {
    map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    default: (id) => {
      if (id !== undefined) map.set(id, defaults(id))
    },
    remove: (id) => map.delete(id),
    update(id, fn) {
      const agent = structuredClone(map.get(id) ?? defaults(id))
      fn(agent)
      map.set(id, agent)
    },
  }
}

function v2TestSidecar() {
  const config = emptyConfig()
  config.agents = {
    build: {
      parent: { model: "zai/glm-5.4" },
      variants: {
        fast: { model: "zai/glm-4.7-flash", prompt_prepend: "Fast mode.", temperature: 0.3, top_p: 0.9, options: { thinking: { type: "enabled" } } },
        plain: { temperature: 0.2 },
      },
    },
    dyn: {
      parent: {},
      variants: { lite: { model: "zai/glm-4.7-flash", prompt_prepend: "Lite mode." } },
    },
  }
  config.profiles = {
    night: {
      match: { model: "zai/glm-5.4" },
      agents: {
        build: {
          parent: { model: "zai/glm-5.4-xhigh" },
          variants: { fast: { model: "zai/glm-4.7-air" } },
        },
      },
    },
    tempOnly: {
      agents: { build: { variants: { fast: { temperature: 0.9 } } } },
    },
  }
  return config
}

function testV2Assembly() {
  const editor = stubV2Editor({
    build: { id: "build", name: "build", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "You are build.", description: "Build things.", mode: "all", hidden: false, color: "#3af", steps: 5, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    dyn: { id: "dyn", name: "dyn", request: { settings: {}, headers: {}, body: {} }, mode: "all", hidden: false, permissions: [] },
    "build-fast": { id: "build-fast", name: "existing", request: { settings: {}, headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] },
  })
  // "taken/echo" aliases to `build-echo`, no conflict; "build/fast" and
  // "build/plain" alias to build-fast/build-plain — build-fast collides with
  // the existing agent, so exactly that variant is skipped with an error.
  const sidecar = v2TestSidecar()
  const assembly = assembleV2Agents(editor, sidecar)

  // Parent patch applied to the parent definition itself.
  const build = editor.map.get("build")
  assert(build.model.id === "glm-5.4", "parent model patch applied to parent definition")

  // Visible alias clone: full copy of the patched parent.
  assert(!assembly.aliases.has("build-fast"), "conflicting alias is skipped")
  assert(assembly.diagnostics.some((item) => item.level === "error" && /conflicts with an existing agent/.test(item.message)), "conflict produces an error diagnostic")
  const plain = editor.map.get("build-plain")
  assert(plain, "non-conflicting variant alias registered")
  assert(plain.mode === "subagent", "alias clone is subagent-capable")
  assert(plain.hidden === false, "visible alias is not hidden")
  assert(plain.model.id === "glm-5.4", "variant without model inherits the patched parent model")
  assert(plain.system === "You are build.", "alias copies the parent system verbatim when the variant has no prompt patch")
  assert(plain.permissions.length === 1 && plain.permissions[0].action === "*", "permissions inherited from parent")
  assert(plain.steps === 5, "steps inherited from parent")

  // Alias with prompt patch over a static-system parent: composed and baked.
  const dynLite = editor.map.get("dyn-lite")
  assert(dynLite, "dynamic-parent variant registered")
  assert(dynLite.system === undefined, "dynamic parent leaves the clone system unset (dynamic default)")
  const liteRoute = assembly.aliases.get("dyn-lite")
  assert(liteRoute?.promptRuntime === true, "dynamic-parent prompt patch is applied at request time")

  // Hidden profile clones.
  const fastClone = editor.map.get(variantCloneId("build-plain", "night"))
  assert(!fastClone, "no profile clone when the profile does not touch the variant")
  const liteClone = editor.map.get(variantCloneId("dyn-lite", "night"))
  assert(!liteClone, "no profile clone for a profile without a variant overlay")
  assert(assembly.aliases.has("build-plain") && assembly.aliases.has("dyn-lite"), "visible aliases registered")

  // tempOnly overlays only temperature: no model clone for build-plain/fast.
  assert(!editor.map.has(variantCloneId("build-plain", "tempOnly")), "temperature-only profile overlay creates no clone")
  // night overlays the fast variant model — but the fast alias was skipped
  // (conflict), so no clone for it either; the parent clone still exists.
  const parentClone = editor.map.get(parentCloneId("build", "night"))
  assert(parentClone, "profile parent model patch creates a hidden parent clone")
  assert(parentClone.hidden === true, "parent clone is hidden")
  assert(parentClone.mode === "subagent", "parent clone is subagent-capable")
  assert(parentClone.model.id === "glm-5.4-xhigh", "parent clone carries the overlaid model")
  assert(parentClone.system === "You are build.", "parent clone copies the parent system")
  assert(assembly.parentClones.get(parentCloneId("build", "night")) === "build", "parent clone maps back to its parent")
}

function testV2AssemblyProfileClone() {
  // Separate fixture: the variant actually registers, so its profile clone exists.
  const editor = stubV2Editor({
    general: { id: "general", name: "general", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "Base system.", mode: "all", hidden: false, permissions: [] },
  })
  const sidecar = emptyConfig()
  sidecar.agents = {
    general: {
      parent: {},
      variants: {
        fast: { model: "zai/glm-4.7-flash", prompt_prepend: "Fast mode." },
      },
    },
  }
  sidecar.profiles = {
    night: {
      match: { model: "zai/glm-5.3" },
      agents: { general: { variants: { fast: { model: "zai/glm-4.7-air", prompt_append: "Night rules." } } } },
    },
  }
  const assembly = assembleV2Agents(editor, sidecar)
  const alias = editor.map.get("general-fast")
  assert(alias, "alias registered")
  assert(alias.model.id === "glm-4.7-flash", "alias carries the variant model")
  assert(alias.system === "Fast mode.\n\nBase system.", "alias system composed from parent with prepend")

  const cloneId = variantCloneId("general-fast", "night")
  const clone = editor.map.get(cloneId)
  assert(clone, "profile clone registered when the overlaid model differs")
  assert(clone.hidden === true, "profile clone hidden")
  assert(clone.model.id === "glm-4.7-air", "profile clone carries the overlaid model")
  assert(clone.system === "Fast mode.\n\nBase system.\n\nNight rules.", "profile clone system composed with the overlaid prompt")
  const route = assembly.routes.get(cloneId)
  assert(route?.profile === "night" && route.alias === "general-fast", "clone route maps back to the visible alias")

  // Request params on the alias patch are applied per request, not baked.
  assert(alias.request.body.temperature === undefined, "request params are not baked into the agent definition")
}

function testV2ExecutionRouting() {
  const editor = stubV2Editor({
    general: { id: "general", name: "general", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "Base system.", mode: "all", hidden: false, permissions: [] },
  })
  const sidecar = emptyConfig()
  sidecar.agents = {
    general: {
      parent: { temperature: 0.7 },
      variants: { fast: { model: "zai/glm-4.7-flash", temperature: 0.3, top_p: 0.9, options: { thinking: { type: "enabled" } } } },
    },
  }
  sidecar.profiles = {
    night: {
      match: { model: "zai/glm-5.3" },
      agents: { general: { parent: { model: "zai/glm-5.3-xhigh" }, variants: { fast: { model: "zai/glm-4.7-air" } } } },
    },
  }
  const assembly = assembleV2Agents(editor, sidecar)

  // No profile: alias executes as itself.
  const direct = resolveExecutionAgent({ agent: "general-fast" }, assembly, undefined)
  assert(direct?.agent === "general-fast" && direct.changed === false, "alias executes as itself without a profile")

  // Profile active: rewritten to the hidden clone.
  const rewritten = resolveExecutionAgent({ agent: "general-fast" }, assembly, { name: "night" })
  assert(rewritten?.agent === variantCloneId("general-fast", "night") && rewritten.changed === true && rewritten.alias === "general-fast", "profile rewrites alias to hidden clone")

  // Base task call under a profile: parent rewritten to the parent clone.
  const baseNoProfile = resolveExecutionAgent({ agent: "general" }, assembly, undefined)
  assert(baseNoProfile?.changed === false, "base parent call untouched without a profile")
  const baseProfile = resolveExecutionAgent({ agent: "general" }, assembly, { name: "night" })
  assert(baseProfile?.agent === parentCloneId("general", "night") && baseProfile.changed === true, "base parent call rewritten under a profile")

  // Unknown agents are left alone.
  assert(resolveExecutionAgent({ agent: "explore" }, assembly, { name: "night" }) === undefined, "unknown agents are not routed")

  // session.context overrides.
  const event = { sessionID: "s1", agent: "general-fast", model: { providerID: "zai", id: "glm-4.7-flash" }, system: [{ type: "text", text: "Fast mode.\n\nBase system." }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  applyContextOverrides(event, { assembly, sidecar, activeProfile: undefined })
  assert(event.generation.temperature === 0.3, "variant temperature applied per request")
  assert(event.generation.topP === 0.9, "variant top_p applied per request")
  assert(event.providerOptions.thinking?.type === "enabled", "variant options applied to providerOptions")
  assert(event.system[0].text === "Fast mode.\n\nBase system.", "baked system left untouched without profile prompt overlay")

  // Profile overlay without a model change still patches the request params.
  const profileEvent = { sessionID: "s1", agent: "general-fast", model: { providerID: "zai", id: "glm-4.7-flash" }, system: [{ type: "text", text: "Fast mode.\n\nBase system." }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  const tempSidecar = emptyConfig()
  tempSidecar.agents = sidecar.agents
  tempSidecar.profiles = { warm: { agents: { general: { variants: { fast: { temperature: 0.8, prompt_append: "Warm rules." } } } } } }
  applyContextOverrides(profileEvent, { assembly, sidecar: tempSidecar, activeProfile: { name: "warm" } })
  assert(profileEvent.generation.temperature === 0.8, "profile-overlaid temperature applied")
  assert(profileEvent.system[0].text === "Base system.\n\nWarm rules.", "profile prompt overlay recomputed from the parent base")

  // Clone route: overlay baked, nothing dynamic.
  const cloneEvent = { sessionID: "s2", agent: variantCloneId("general-fast", "night"), model: { providerID: "zai", id: "glm-4.7-air" }, system: [{ type: "text", text: "baked" }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  applyContextOverrides(cloneEvent, { assembly, sidecar, activeProfile: undefined })
  assert(cloneEvent.system[0].text === "baked", "clone system stays baked")

  // Parent route: global parent patch applies wherever the parent runs.
  const parentEvent = { sessionID: "s3", agent: "general", model: { providerID: "zai", id: "glm-5.3" }, system: [{ type: "text", text: "Base system." }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  applyContextOverrides(parentEvent, { assembly, sidecar, activeProfile: undefined })
  assert(parentEvent.generation.temperature === 0.7, "parent temperature patch applied by agent key")
  assert(parentEvent.system[0].text === "Base system.", "static parent system already baked at assembly")

  // Hidden parent clone normalizes to its parent for request params.
  const parentCloneEvent = { sessionID: "s4", agent: parentCloneId("general", "night"), model: { providerID: "zai", id: "glm-5.3-xhigh" }, system: [{ type: "text", text: "Base system." }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  applyContextOverrides(parentCloneEvent, { assembly, sidecar, activeProfile: undefined })
  assert(parentCloneEvent.generation.temperature === 0.7, "parent clone inherits the parent request patch")
}

function testV2VariantOnlyProfileOverlay() {
  // A profile that overrides ONLY the model variant must still produce a
  // clone: effective refs (parent model + variant) differ even though the
  // patches carry no `model` field.
  const editor = stubV2Editor({
    general: { id: "general", name: "general", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: { a: 1 }, headers: { h: "1" }, body: { b: 1 } }, system: "Base.", mode: "all", hidden: false, permissions: [] },
  })
  const sidecar = emptyConfig()
  sidecar.agents = {
    general: {
      parent: {},
      variants: { deep: { variant: "high" } },
    },
  }
  sidecar.profiles = {
    quick: { match: { model: "zai/glm-5.3" }, agents: { general: { variants: { deep: { variant: "low" } } } } },
  }
  const assembly = assembleV2Agents(editor, sidecar)
  const alias = editor.map.get("general-deep")
  assert(alias, "variant-only alias registered")
  assert(alias.model.id === "glm-5.3" && alias.model.variant === "high", "alias stamps the variant over the parent model")
  const clone = editor.map.get(variantCloneId("general-deep", "quick"))
  assert(clone, "variant-only profile overlay registers a clone")
  assert(clone.model.id === "glm-5.3" && clone.model.variant === "low", "clone carries the overlaid variant")
  assert(clone.request.settings.a === 1 && clone.request.body.b === 1, "clone copies the parent request block")
}

function testV2ProfileParentOnVariantLessAgent() {
  // v1 parity: profile parent patches apply to base task calls of agents
  // that have NO variants configured at all.
  const editor = stubV2Editor({
    explore: { id: "explore", name: "explore", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "Explore.", mode: "all", hidden: false, permissions: [] },
  })
  const sidecar = emptyConfig()
  sidecar.agents = {}
  sidecar.profiles = {
    night: { match: { model: "zai/glm-5.3" }, agents: { explore: { parent: { model: "zai/glm-5.3-xhigh" }, variants: {} } } },
  }
  const assembly = assembleV2Agents(editor, sidecar)
  assert(assembly.parents.has("explore"), "profile-referenced agent becomes a parent route without sidecar variants")
  const clone = editor.map.get(parentCloneId("explore", "night"))
  assert(clone, "profile parent patch creates a clone for a variant-less agent")
  assert(clone.hidden === true && clone.model.id === "glm-5.3-xhigh", "variant-less parent clone carries the overlaid model")
  const rewritten = resolveExecutionAgent({ agent: "explore" }, assembly, { name: "night" })
  assert(rewritten?.agent === parentCloneId("explore", "night") && rewritten.changed === true, "base call to variant-less agent rewrites under profile")
}

function testV2ProfileParentFlowsIntoVariants() {
  // v1 liveRoute parity: profile parent patches compose into variant
  // execution through the propagate/inherit rules.
  const editor = stubV2Editor({
    general: { id: "general", name: "general", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "Base.", mode: "all", hidden: false, permissions: [] },
  })
  const sidecar = emptyConfig()
  sidecar.agents = {
    general: {
      parent: { temperature: 0.5, propagate: { temperature: true } },
      variants: { fast: { model: "zai/glm-4.7-flash" } },
    },
  }
  sidecar.profiles = {
    hot: { match: { model: "zai/glm-5.3" }, agents: { general: { parent: { temperature: 0.9 }, variants: {} } } },
  }
  const assembly = assembleV2Agents(editor, sidecar)

  const noProfile = { sessionID: "s", agent: "general-fast", model: { providerID: "zai", id: "glm-4.7-flash" }, system: [{ type: "text", text: "Base." }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  applyContextOverrides(noProfile, { assembly, sidecar, activeProfile: undefined })
  assert(noProfile.generation.temperature === 0.5, "propagated parent temperature reaches the variant without a profile")

  const hot = { sessionID: "s", agent: "general-fast", model: { providerID: "zai", id: "glm-4.7-flash" }, system: [{ type: "text", text: "Base." }], messages: [], tools: {}, generation: {}, providerOptions: {} }
  applyContextOverrides(hot, { assembly, sidecar, activeProfile: { name: "hot" } })
  assert(hot.generation.temperature === 0.9, "profile parent temperature flows into variant execution")

  const composed = composeVariantPatch({ temperature: 0.5, propagate: { temperature: true } }, { temperature: 0.9 }, { model: "zai/glm-4.7-flash" }, undefined, sidecar)
  assert(composed.temperature === 0.9, "composeVariantPatch overlays the profile parent patch before inheritance")
}

function testV2ParentDescriptionAndCollisions() {
  const editor = stubV2Editor({
    general: { id: "general", name: "general", request: { settings: {}, headers: {}, body: {} }, system: "Base.", description: "General agent.", mode: "all", hidden: false, permissions: [] },
    "av:general-fast@night": { id: "av:general-fast@night", name: "user clone", request: { settings: {}, headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] },
  })
  const sidecar = emptyConfig()
  sidecar.agents = {
    general: {
      parent: {},
      variants: { fast: { model: "zai/glm-4.7-flash" } },
    },
  }
  sidecar.profiles = {
    night: { match: { model: "zai/glm-5.3" }, agents: { general: { variants: { fast: { model: "zai/glm-4.7-air" } } } } },
  }
  const assembly = assembleV2Agents(editor, sidecar)
  const parent = editor.map.get("general")
  assert(/Available variants: general-fast\./.test(parent.description ?? ""), "parent description advertises its aliases (v1 parity)")
  assert(parent.description?.startsWith("General agent."), "parent description patch preserves the base text")
  assert(!editor.map.has("av:general-fast@night") || editor.map.get("av:general-fast@night").name === "user clone", "clone id collision leaves the user agent untouched")
  assert(assembly.diagnostics.some((item) => item.level === "error" && /conflicts with an existing agent/.test(item.message)), "clone collision produces an error diagnostic")
}


function testPartialProviderOverrideWithVariants() {
  const sidecar = {
    debug: false,
    routing: { prompt_markers: false },
    ui: { width: "large", height: "normal" },
    models: {},
    agents: {
      explore: {
        parent: {},
        variants: {
          light: {
            model: "zai-coding-plan/glm-5.2",
            variant: "none",
          },
        },
      },
    },
  }
  const cfg = {
    provider: {
      "zai-coding-plan": {
        models: {
          "glm-5.2": {
            variants: {
              none: { thinking: { type: "disabled" }, reasoningEffort: "none" },
              high: { thinking: { type: "enabled" }, reasoningEffort: "high" },
              max: { thinking: { type: "enabled" }, reasoningEffort: "max" },
            },
          },
        },
      },
    },
    agent: {},
  }
  const assembled = __testAssembleAgents(cfg, sidecar)
  assertGenerated(assembled, cfg, "explore-light")
  assert(hardDiagnostics(assembled).length === 0, `partial provider override produced blocking diagnostics: ${hardDiagnostics(assembled).map((item) => item.message).join("; ")}`)
}

function testMissingCustomProviderModelIsDeferred() {
  const sidecar = {
    debug: false,
    routing: { prompt_markers: false },
    ui: { width: "large", height: "normal" },
    models: {},
    agents: {
      explore: {
        parent: {},
        variants: {
          weird: { model: "custom-provider/missing-model" },
        },
      },
    },
  }
  const cfg = { provider: { "custom-provider": { models: { other: {} } } }, agent: {} }
  const assembled = __testAssembleAgents(cfg, sidecar)
  assertGenerated(assembled, cfg, "explore-weird")
  assert(hardDiagnostics(assembled).length === 0, "custom provider model existence must be deferred until merged catalog validation")
}

function testMalformedModelShapeStillSkips() {
  const sidecar = {
    debug: false,
    routing: { prompt_markers: false },
    ui: { width: "large", height: "normal" },
    models: {},
    agents: {
      explore: {
        parent: {},
        variants: {
          bad: { model: "not-a-provider-prefixed-model" },
        },
      },
    },
  }
  const cfg = { agent: {} }
  const assembled = __testAssembleAgents(cfg, sidecar)
  assert(!cfg.agent["explore-bad"], "malformed model references should still skip the variant at startup")
  assert(assembled.diagnostics.some((item) => /provider\/model/.test(item.message)), "malformed model should produce a shape diagnostic")
}

function testMarkerlessDefaultAndLegacyScrub() {
  assert(emptyConfig().routing.prompt_markers === false, "prompt markers must stay off by default")

  const route = {
    alias: "explore-heavy",
    parent: "explore",
    targetAgent: "explore",
    key: "heavy",
    patch: {},
    model: "openai/gpt-5.5",
    variant: "high",
  }
  const routes = new Map([[route.alias, route]])
  const input = {
    subagent_type: "explore",
    selected_alias: "explore-heavy",
    agent_variant: "explore-heavy",
    routed_agent: "explore",
    effective_model: "openai/gpt-5.5",
    prompt: `Inspect this. ${__testInternals.marker("tok_test", route)}`,
  }
  const result = __testInternals.scrubTaskInput(input, { routes })
  assert(result.count > 0, "legacy routing artifacts should be scrubbed")
  assert(input.subagent_type === "explore-heavy", "scrub should restore the visible alias when proof exists")
  assert(!("selected_alias" in input), "selected_alias must be removed")
  assert(!("agent_variant" in input), "agent_variant must be removed")
  assert(!String(input.prompt).includes("agent-variants-route"), "route marker must be removed from prompt")
}

function testParallelBaseTaskCannotClaimVariantRoute() {
  const route = {
    alias: "explore-heavy",
    parent: "explore",
    targetAgent: "explore",
    key: "heavy",
    patch: {},
    model: "openai/gpt-5.5",
  }
  const pendingRoute = {
    ...route,
    callID: "heavy-call",
    parentSessionID: "parent-session",
    createdAt: Date.now(),
  }
  const pending = [pendingRoute]
  const byCall = new Map([[pendingRoute.callID, route]])
  const bySession = new Map()
  const knownRoutes = new Map([[route.alias, route]])
  const baseOutput = { message: { agent: "explore", model: { providerID: "zai-coding-plan", modelID: "glm-5.2" } } }
  const heavyOutput = { message: { agent: "explore", model: { providerID: "zai-coding-plan", modelID: "glm-5.2" } } }

  const base = __testInternals.correlateTaskRoute(
    pending,
    byCall,
    bySession,
    knownRoutes,
    "base-child",
    { id: "base-part", callID: "base-call" },
  )
  if (base.route) __testInternals.applyMessageModel(baseOutput, base.route)

  const heavy = __testInternals.correlateTaskRoute(
    pending,
    byCall,
    bySession,
    knownRoutes,
    "heavy-child",
    { id: "heavy-part", callID: "heavy-call" },
  )
  if (heavy.route) __testInternals.applyMessageModel(heavyOutput, heavy.route)

  const baseModel = `${baseOutput.message.model.providerID}/${baseOutput.message.model.modelID}`
  const heavyModel = `${heavyOutput.message.model.providerID}/${heavyOutput.message.model.modelID}`
  assert(
    baseModel === "zai-coding-plan/glm-5.2",
    `parallel base task must keep zai-coding-plan/glm-5.2, got ${baseModel}; sibling heavy task resolved to ${heavyModel}`,
  )
  assert(heavyModel === route.model, `parallel heavy task should use ${route.model}, got ${heavyModel}`)
  assert(pending.length === 0, "the exact heavy task should consume its own pending route")

  byCall.clear()
  bySession.clear()
  const resumed = __testInternals.correlateTaskRoute(
    pending,
    byCall,
    bySession,
    knownRoutes,
    "heavy-child",
    {
      id: "heavy-part",
      callID: "heavy-call",
      state: { metadata: { agentVariants: { alias: route.alias, routedAgent: route.targetAgent } } },
    },
  )
  assert(resumed.route?.alias === route.alias, "persisted task metadata should reconstruct a variant route after transient call state is gone")
  assert(bySession.get("heavy-child")?.alias === route.alias, "a direct variant-child continuation should retain request and prompt patches")
}

function testRuntimeDependencyMetadata() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert(pkg.files.includes("src"), "published package must include runtime TUI source imports")
  assert(pkg.files.includes("tsconfig.json"), "published TUI source must include its JSX compiler configuration")
  assert(pkg.dependencies?.["@opentui/solid"] === "^0.4.1", "@opentui/solid must stay within the compatible packaged JSX runtime line")
  assert(pkg.dependencies?.["solid-js"] === "1.9.12", "solid-js must stay pinned to the @opentui/solid peer version")
  const tui = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8")
  assert(tui.startsWith("/** @jsxImportSource @opentui/solid */"), "published TUI source must explicitly select the Solid JSX runtime")
}

function testSelectionTierInference() {
  const config = emptyConfig()
  config.models.balanced = {
    model: "openai/gpt-5.6-terra",
    label: "GPT-5.6 Terra",
  }

  const cases = [
    { label: "GPT-5.6 Sol", key: "tier", model: "openai/gpt-5.6-sol", expected: "heavy" },
    { label: "bare GPT-5.6 alias", key: "tier", model: "openai/gpt-5.6", expected: "heavy" },
    { label: "GPT-5.5", key: "tier", model: "openai/gpt-5.5", expected: "heavy" },
    { label: "GPT-5.5 low reasoning", key: "tier", model: "openai/gpt-5.5", variant: "low", expected: "heavy" },
    { label: "GPT-5.6 Terra", key: "tier", model: "openai/gpt-5.6-terra", expected: "light" },
    { label: "GPT-5.6 Terra max reasoning", key: "tier", model: "openai/gpt-5.6-terra", variant: "max", expected: "light" },
    { label: "GPT-5.5 mini high reasoning", key: "tier", model: "openai/gpt-5.5-mini", variant: "high", expected: "light" },
    { label: "GPT-5.6 Luna", key: "tier", model: "openai/gpt-5.6-luna", expected: "basic" },
    { label: "GPT-5.6 Luna max reasoning", key: "tier", model: "openai/gpt-5.6-luna", variant: "max", expected: "basic" },
    { label: "GPT nano", key: "tier", model: "openai/gpt-5-nano", expected: "basic" },
    { label: "Terra model shortcut", key: "tier", model: "balanced", expected: "light" },
    { label: "explicit heavy alias overrides Luna", key: "heavy", model: "openai/gpt-5.6-luna", expected: "heavy" },
    { label: "explicit basic alias overrides Sol", key: "basic", model: "openai/gpt-5.6-sol", expected: "basic" },
    { label: "explicit light alias overrides Sol", key: "light", model: "openai/gpt-5.6-sol", expected: "light" },
    { label: "Sol overrides data-entry alias", key: "data-entry", model: "openai/gpt-5.6-sol", expected: "heavy" },
    { label: "explicit heavy alias overrides Terra", key: "heavy", model: "openai/gpt-5.6-terra", expected: "heavy" },
    { label: "unknown model uses nano alias fallback", key: "nano", model: "vendor/generic-model", expected: "basic" },
    { label: "unknown model uses heavy alias fallback", key: "heavy", model: "vendor/generic-model", expected: "heavy" },
    { label: "functional intent overrides model tier", key: "verification", model: "openai/gpt-5.6-luna", expected: "verification" },
    // flash tier: distinct fast/secondary model lines.
    { label: "GLM flash", key: "tier", model: "zai-coding-plan/glm-5.3-flash", expected: "flash" },
    { label: "generic flash model", key: "tier", model: "vendor/model-flash", expected: "flash" },
    { label: "generic fast model", key: "tier", model: "vendor/model-fast", expected: "flash" },
    { label: "low reasoning variant on generic model", key: "tier", model: "vendor/generic-model", variant: "low", expected: "flash" },
    { label: "explicit flash alias overrides Sol", key: "flash", model: "openai/gpt-5.6-sol", expected: "flash" },
    // light tier: weaker siblings of the main family.
    { label: "sonnet stays light", key: "tier", model: "vendor/claude-sonnet", expected: "light" },
    { label: "light-named model stays light", key: "tier", model: "vendor/model-light", expected: "light" },
    // basic tier: genuinely small lines.
    { label: "haiku drops to basic", key: "tier", model: "vendor/claude-haiku", expected: "basic" },
    { label: "lite drops to basic", key: "tier", model: "vendor/model-lite", expected: "basic" },
    // heavy tier additions.
    { label: "opus stays heavy", key: "tier", model: "vendor/claude-opus", expected: "heavy" },
    { label: "fable is heavy", key: "tier", model: "vendor/model-fable", expected: "heavy" },
  ]

  for (const test of cases) {
    const actual = inferredSelectionPreset("explore", test.key, { model: test.model, variant: test.variant }, config)?.key
    assert(actual === test.expected, `${test.label} should infer ${test.expected}, got ${actual ?? "none"}`)
  }

  const providerToken = inferredSelectionPreset("explore", "tier", { model: "sol/generic-model" }, config)
  assert(providerToken === undefined, "provider names must not be interpreted as model capability tiers")
  const semanticTaskName = inferredSelectionPreset("explore", "data-entry", { model: "vendor/generic-model" }, config)
  assert(semanticTaskName?.key === "basic", "semantic task names should provide a fallback when model capability is unknown")
  // Capability ladder order: basic -> flash -> light -> heavy.
  const tierKeys = SELECTION_PRESETS.slice(0, 4).map((preset) => preset.key)
  assert(tierKeys.join(",") === "basic,flash,light,heavy", `capability presets should read basic,flash,light,heavy - got ${tierKeys.join(",")}`)
  // The user's real explore variants infer exactly as configured.
  const exploreHeavy = inferredSelectionPreset("explore", "heavy", { model: "zai-coding-plan/glm-5.3", variant: "max" }, config)
  assert(exploreHeavy?.key === "heavy", "explore heavy stays heavy")
  const exploreLight = inferredSelectionPreset("explore", "light", { model: "zai-coding-plan/glm-5.3-flash", variant: "high" }, config)
  assert(exploreLight?.key === "light", "explicit light alias still wins over flash model inference")
  const renamedExploreFlash = inferredSelectionPreset("explore", "flash", { model: "zai-coding-plan/glm-5.3-flash", variant: "high" }, config)
  assert(renamedExploreFlash?.key === "flash", "renamed flash alias infers flash")
}

function testProfiles() {
  // profileMatchesModel: wildcard, exact variant, array variant, default normalization.
  assert(!profileMatchesModel(undefined, "any", "model"), "rule-less profile never auto-matches (manual only)")
  assert(profileMatchesModel({ model: "zai/glm-5.3" }, "zai", "glm-5.3"), "model-only rule matches any variant")
  assert(!profileMatchesModel({ model: "zai/glm-5.3" }, "zai", "glm-5.2"), "different model does not match")
  assert(profileMatchesModel({ model: "zai/glm-5.3", variant: "high" }, "zai", "glm-5.3", "high"), "string variant matches")
  assert(!profileMatchesModel({ model: "zai/glm-5.3", variant: "high" }, "zai", "glm-5.3", "low"), "other variant does not match")
  assert(profileMatchesModel({ model: "zai/glm-5.3", variant: "default" }, "zai", "glm-5.3", "default"), "rule variant default matches default session")
  assert(!profileMatchesModel({ model: "zai/glm-5.3", variant: "high" }, "zai", "glm-5.3", undefined), "rule variant high does not match default session")
  assert(profileMatchesModel({ model: "zai/glm-5.3", variant: ["high", "max"] }, "zai", "glm-5.3", "max"), "array variant matches member")
  assert(!profileMatchesModel({ model: "zai/glm-5.3", variant: ["high"] }, "zai", "glm-5.3", undefined), "undefined variant normalizes to default")
  assert(!profileMatchesModel({ model: "glmbad" }, "zai", "glm-5.3"), "malformed rule model never matches")

  // resolveActiveProfile: manual pin wins; ordered last-match-wins; dead pin disables matching.
  const config = emptyConfig()
  config.profiles = {
    light: { match: { model: "zai/glm-5.3" }, agents: {} },
    heavy: { match: { model: "zai/glm-5.3", variant: "high" }, agents: {} },
    manualOnly: { agents: {} },
  }
  const primary = { providerID: "zai", modelID: "glm-5.3", variant: "high" }
  assert(resolveActiveProfile(config, primary)?.name === "heavy", "last matching profile wins")
  assert(resolveActiveProfile(config, { providerID: "zai", modelID: "glm-5.3" })?.name === "light", "wildcard profile matches default variant")
  assert(resolveActiveProfile(config) === undefined, "no primary and no pin resolves nothing")
  config.routing.activeProfile = "manualOnly"
  assert(resolveActiveProfile(config, primary)?.source === "manual", "manual pin wins over matching")
  config.routing.activeProfile = "gone"
  assert(resolveActiveProfile(config, primary) === undefined, "dead manual pin suppresses matching")

  // overlayProfilePatch: replaces set fields, falls through unset, hot fields only.
  const base = { model: "zai/glm-5.3", temperature: 0.4, description: "keep" }
  const overlaid = overlayProfilePatch(base, { temperature: 0.9, prompt: "go" })
  assert(overlaid.temperature === 0.9, "profile field replaces default")
  assert(overlaid.model === "zai/glm-5.3", "unset profile fields fall through")
  assert(overlaid.description === "keep", "non-hot default fields survive")
  assert(overlaid.prompt === "go", "profile can add hot fields")
  const structural = overlayProfilePatch(base, { description: "hack" })
  assert(structural.description === "keep", "structural fields cannot be overlaid even if forced")

  // Schema: profile patches reject structural fields (strict object).
  const strict = SidecarConfig.safeParse({
    debug: false,
    routing: { prompt_markers: false },
    ui: { width: "large", height: "normal" },
    models: {},
    profiles: { bad: { agents: { general: { parent: { description: "nope" }, variants: {} } } } },
    agents: {},
  })
  assert(!strict.success, "ProfilePatch strict schema rejects structural fields")

  // Defaults round-trip: empty config carries an empty profiles record.
  const parsed = SidecarConfig.parse({})
  assert(parsed.profiles && typeof parsed.profiles === "object", "profiles defaults to a record")
  assert(parsed.routing.activeProfile === undefined, "activeProfile unset by default")

  // Lens helpers: overlay reads, source hints, write routing, container pruning.
  const lensConfig = emptyConfig()
  lensConfig.agents.general = {
    parent: { temperature: 0.2, model: "zai/glm-5.3" },
    variants: { quick: { model: "zai/glm-5.2", temperature: 0.1 } },
  }
  lensConfig.profiles = { solo: { agents: { general: { parent: { temperature: 0.8 }, variants: { quick: { top_p: 0.5 } } } } } }
  assert(profileVariantPatch(lensConfig, "solo", "general", "quick")?.top_p === 0.5, "profileVariantPatch reads a variant override")
  assert(profileVariantPatch(lensConfig, "solo", "general", "missing") === undefined, "profileVariantPatch undefined for unpatched variant")
  assert(profileParentPatch(lensConfig, "solo", "general")?.temperature === 0.8, "profileParentPatch reads a parent override")
  assert(profileFieldSource(lensConfig, "solo", "general", "temperature") === "profile", "parent field source is profile when overridden")
  assert(profileFieldSource(lensConfig, "solo", "general", "model") === "global", "parent field source is global when not overridden")
  assert(profileFieldSource(lensConfig, "solo", "general", "top_p", "quick") === "profile", "variant field source is profile when overridden")
  assert(profileFieldSource(lensConfig, "solo", "general", "model", "quick") === "global", "variant field source is global when not overridden")

  const lensWritten = setProfileFieldIn(lensConfig, "solo", "general", { kind: "variant", key: "quick" }, "temperature", 0.7)
  assert(lensWritten.profiles.solo.agents.general.variants.quick.temperature === 0.7, "lens write lands in the profile variant patch")
  assert(lensConfig.profiles.solo.agents.general.variants.quick.temperature === undefined, "lens write does not mutate the source config")
  assert(lensWritten.agents.general.variants.quick.temperature === 0.1, "lens write leaves the global default untouched")

  const lensCleared = setProfileFieldIn(lensWritten, "solo", "general", { kind: "variant", key: "quick" }, "top_p", "")
  assert(lensCleared.profiles.solo.agents.general.variants.quick.top_p === undefined, "empty value clears the profile override")

  const lensPruned = setProfileFieldIn(lensCleared, "solo", "general", { kind: "variant", key: "quick" }, "temperature", "")
  assert(lensPruned.profiles.solo.agents.general.variants.quick === undefined, "empty variant patch is pruned")
  assert(lensPruned.profiles.solo.agents.general.parent.temperature === 0.8, "sibling patches survive pruning")

  const lensCreated = setProfileFieldIn(emptyConfig(), "fresh", "build", { kind: "parent" }, "model", "zai/glm-5.3")
  assert(lensCreated.profiles.fresh.agents.build.parent.model === "zai/glm-5.3", "lens write creates the profile/agent/parent chain on demand")

  const lensVariantDrop = setProfileFieldIn(lensCreated, "fresh", "build", { kind: "parent" }, "model", "zai/glm-5.2")
  assert(lensVariantDrop.profiles.fresh.agents.build.parent.model === "zai/glm-5.2", "model rewrite updates the profile patch")

  // Model change drops a pinned variant override (mirrors global semantics).
  const withVariant = setProfileFieldIn(lensCreated, "fresh", "build", { kind: "parent" }, "variant", "high")
  assert(withVariant.profiles.fresh.agents.build.parent.variant === "high", "variant override set")
  const modelChanged = setProfileFieldIn(withVariant, "fresh", "build", { kind: "parent" }, "model", "zai/glm-5.2")
  assert(modelChanged.profiles.fresh.agents.build.parent.variant === undefined, "changing the model drops the pinned variant override")
  const sameModel = setProfileFieldIn(withVariant, "fresh", "build", { kind: "parent" }, "model", "zai/glm-5.3")
  assert(sameModel.profiles.fresh.agents.build.parent.variant === "high", "rewriting the same model keeps the variant override")
}

async function testLiveRepairNeverRevertsRunningParts() {
  const { repairLiveTaskPart, persistCleanedParts, LIVE_REPAIR_DELAYS } = __testInternals
  const route = { alias: "explore-light", targetAgent: "explore", parent: "explore", model: "opencode/muse" }
  const routes = new Map([["explore-light", route]])

  const makePart = () => ({
    id: "prt_race1",
    messageID: "msg_race1",
    sessionID: "ses_race1",
    type: "tool",
    tool: "task",
    callID: "call_race1",
    state: {
      status: "running",
      input: { subagent_type: "explore", prompt: "x", selected_alias: "explore-light" },
      metadata: { sessionId: "ses_child1" },
      time: { start: 1 },
    },
  })

  // Fake client: reads return the CURRENT store clone; PATCHes apply
  // last-write-wins (like the real DB + event bridge). `completeAfterMs`
  // simulates OpenCode's processor completing the part AFTER the tool hook.
  const makeClient = ({ completeAfterMs }) => {
    const store = { part: makePart() }
    const patches = []
    const client = {
      __patches: patches,
      session: {
        messages: async () => ({ data: [{ parts: [structuredClone(store.part)] }] }),
        message: async () => ({ data: { parts: [structuredClone(store.part)] } }),
      },
      _client: {
        patch: async (request) => {
          patches.push(structuredClone(request.body))
          store.part = structuredClone(request.body)
          return { data: {}, response: { ok: true, status: 200 } }
        },
      },
    }
    if (completeAfterMs !== undefined) {
      setTimeout(() => {
        // Mirrors the processor's completed write: it carries the after-hook's
        // mutated metadata (agentVariants) alongside status/output.
        store.part = {
          ...store.part,
          state: {
            ...store.part.state,
            status: "completed",
            output: "LIGHT-OK <task/>",
            metadata: {
              ...store.part.state.metadata,
              agentVariants: { alias: "explore-light", routedAgent: "explore" },
            },
          },
        }
      }, completeAfterMs)
    }
    return client
  }

  // 1. The production race: the repair's first reads see `running`, the
  //    processor completes the part mid-ladder. The repair must NEVER write a
  //    running snapshot over the completed one.
  {
    const client = makeClient({ completeAfterMs: 120 })
    const repaired = repairLiveTaskPart({
      client,
      directory: "dir",
      sessionID: "ses_race1",
      callID: "call_race1",
      route,
      routes,
      debug: false,
    })
    const finished = await Promise.race([
      repaired.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
    ])
    if (!finished) throw new Error("live repair did not settle within the ladder")
    const statuses = client.__patches.map((body) => body.state?.status)
    if (client.__patches.length === 0) throw new Error("live repair should repair once the part completes")
    if (!statuses.every((status) => status === "completed")) throw new Error(`live repair wrote non-completed snapshots: ${statuses.join(",")}`)
    const final = client.__patches.at(-1)
    if (final.state.metadata?.agentVariants?.alias !== "explore-light") throw new Error("live repair must stamp agentVariants metadata")
    if (final.state.input?.selected_alias !== undefined) throw new Error("live repair must scrub plugin arg keys")
  }

  // 2. A part that never completes is left untouched.
  {
    const original = [...LIVE_REPAIR_DELAYS]
    LIVE_REPAIR_DELAYS.length = 0
    LIVE_REPAIR_DELAYS.push(0, 5, 10)
    try {
      const client = makeClient({ completeAfterMs: undefined })
      return repairLiveTaskPart({ client, directory: "dir", sessionID: "ses_race1", callID: "call_race1", route, routes, debug: false }).then(() => {
        try {
          if (client.__patches.length !== 0) throw new Error("live repair must not touch a part that never completed")
        } finally {
          LIVE_REPAIR_DELAYS.length = 0
          for (const value of original) LIVE_REPAIR_DELAYS.push(value)
        }
      })
    } catch (error) {
      LIVE_REPAIR_DELAYS.length = 0
      for (const value of original) LIVE_REPAIR_DELAYS.push(value)
      throw error
    }
  }
}

async function testHistoryRepairSkipsRunningParts() {
  const { persistCleanedParts } = __testInternals
  const route = { alias: "explore-light", targetAgent: "explore", parent: "explore", model: "opencode/muse" }
  const routes = new Map([["explore-light", route]])
  const snapshot = {
    id: "prt_hist1",
    messageID: "msg_hist1",
    sessionID: "ses_hist1",
    type: "tool",
    tool: "task",
    callID: "call_hist1",
    state: {
      status: "completed",
      input: { subagent_type: "explore", prompt: "x" },
      output: "done",
      metadata: { sessionId: "ses_child2" },
      time: { start: 1, end: 2 },
    },
  }
  // Fresh stored state is RUNNING (processor has not persisted completion
  // yet) - the history repair must skip instead of writing anything.
  const client = {
    session: {
      messages: async () => ({ data: [{ parts: [{ ...snapshot, state: { ...snapshot.state, status: "running", output: undefined } }] }] }),
      message: async () => ({ data: { parts: [{ ...snapshot, state: { ...snapshot.state, status: "running", output: undefined } }] } }),
    },
    _client: {
      patch: async () => {
        throw new Error("history repair must not PATCH a running stored part")
      },
    },
  }
  const result = await persistCleanedParts(
    client,
    "dir",
    [{ part: structuredClone(snapshot), before: "a", after: "b", cleaned: 1 }],
    routes,
    false,
    "history",
  )
  if (result.repaired !== 0) throw new Error(`history repair should skip running parts, repaired=${result.repaired}`)
}

testProfiles()
testPaletteCategory()
testDualEntryModules()
testV2Assembly()
testV2AssemblyProfileClone()
testV2ExecutionRouting()
testV2VariantOnlyProfileOverlay()
testV2ProfileParentOnVariantLessAgent()
testV2ProfileParentFlowsIntoVariants()
testV2ParentDescriptionAndCollisions()
testPartialProviderOverrideWithVariants()
testMissingCustomProviderModelIsDeferred()
testMalformedModelShapeStillSkips()
testMarkerlessDefaultAndLegacyScrub()
testParallelBaseTaskCannotClaimVariantRoute()
testRuntimeDependencyMetadata()
testSelectionTierInference()
await testLiveRepairNeverRevertsRunningParts()
await testCorrelationV2()
await testDisableBase()

// Base-only disable: parent hidden + fresh direct calls rejected with the
// variant list; variants stay registered and alias/resume calls unaffected.
async function testDisableBase() {
  // --- v1 assembly ---
  {
    const cfg = { agent: { explore: {}, custom: { description: "Custom agent." } } }
    const sidecar = emptyConfig()
    sidecar.agents = {
      explore: { parent: {}, disable_base: true, variants: { light: { name: "explore-light", model: "opencode/muse-spark-1.3-contributor-free" } } },
      custom: { parent: {}, disable_base: true, variants: { lite: { name: "custom-lite" } } },
    }
    __testAssembleAgents(cfg, sidecar)
    assert(cfg.agent.explore.hidden === true, "v1: disable_base hides the builtin parent")
    assert(cfg.agent.custom.hidden === true, "v1: disable_base hides the custom parent")
    assert(cfg.agent["explore-light"] !== undefined, "v1: builtin variant still registered")
    assert(cfg.agent["custom-lite"] !== undefined, "v1: custom variant still registered")
    assert(cfg.agent["custom-lite"].hidden === undefined, "v1: hidden does not leak onto variant copies")
    assert(cfg.agent["explore-light"].hidden === undefined, "v1: builtin variant copy stays visible")
  }
  {
    // Full disable still removes the family entirely.
    const cfg = { agent: { explore: {} } }
    const sidecar = emptyConfig()
    sidecar.agents = { explore: { parent: {}, disable: true, disable_base: true, variants: { light: { name: "explore-light" } } } }
    __testAssembleAgents(cfg, sidecar)
    assert(cfg.agent["explore-light"] === undefined, "v1: full disable skips variants")
  }

  // --- v1 before-hook: rejection semantics ---
  {
    const tmpHome = mkdtempSync(path.join(tmpdir(), "av-base-"))
    mkdirSync(path.join(tmpHome, ".config", "opencode"), { recursive: true })
    const sidecar = emptyConfig()
    sidecar.agents = { explore: { parent: {}, disable_base: true, variants: { "explore-light": { name: "explore-light", model: "opencode/muse-spark-1.3-contributor-free" } } } }
    writeFileSync(path.join(tmpHome, ".config", "opencode", "agent-variants.jsonc"), JSON.stringify(sidecar), "utf8")
    const realProfile = process.env.USERPROFILE
    const realHome = process.env.HOME
    process.env.USERPROFILE = tmpHome
    process.env.HOME = tmpHome
    try {
      const fakeClient = {
        tui: { showToast: async () => true },
        session: {
          get: async ({ path }) => ({ data: { id: path.id, model: { providerID: "closedrouter", modelID: "glm-5.3" } } }),
          messages: async () => ({ data: [] }),
        },
      }
      const hooks = await __testInternals.createHooks({ client: fakeClient, directory: "C:/x" }, sidecar)
      await hooks.config({ agent: { explore: {} } })

      // Fresh direct call: rejected with the variant list.
      let rejected
      try {
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: "c1" }, { args: { subagent_type: "explore", prompt: "x" } })
        rejected = undefined
      } catch (error) {
        rejected = error
      }
      assert(rejected && /Agent "explore" is disabled - use one of its variants: explore-light/.test(String(rejected?.message)), `fresh base call is rejected with the variant list (got ${rejected?.message ?? "no error"})`)

      // task_id resume of an old base task: allowed.
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: "c2" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_old_child" } })

      // Alias call: routes normally (rewrites to the hidden parent).
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: "c3" }, { args: { subagent_type: "explore-light", prompt: "x" } })
    } finally {
      process.env.USERPROFILE = realProfile
      process.env.HOME = realHome
      rmSync(tmpHome, { recursive: true, force: true })
    }
  }

  // --- v1 assembly: unification - config-hidden AV parents are base-disabled ---
  {
    const cfg = { agent: { explore: { hidden: true }, historian: { hidden: true }, plain: { hidden: true }, noentry: { hidden: true } } }
    const sidecar = emptyConfig()
    sidecar.agents = {
      explore: { parent: {}, variants: { light: { name: "explore-light", model: "opencode/muse-spark-1.3-contributor-free" } } },
      // No enabled variants: config-hidden must NOT reject (agent stays reachable... via nothing, but no silent lockout).
      plain: { parent: {}, variants: { dead: { disable: true } } },
      // Sidecar entry without variants at all: never auto-disabled.
      bare: { parent: {}, variants: {} },
    }
    const assembled = __testAssembleAgents(cfg, sidecar)
    assert(assembled.hiddenBaseParents.has("explore"), "v1: config-hidden AV parent with enabled variants is base-disabled")
    assert(!assembled.hiddenBaseParents.has("plain"), "v1: config-hidden parent without enabled variants stays callable")
    assert(!assembled.hiddenBaseParents.has("bare"), "v1: variant-less sidecar parent is never auto-disabled")
    assert(!assembled.hiddenBaseParents.has("historian") && !assembled.hiddenBaseParents.has("noentry"), "v1: hidden agents without sidecar entries are never touched")
  }

  // --- v1 before-hook: unification rejection ---
  {
    const tmpHome = mkdtempSync(path.join(tmpdir(), "av-unify-"))
    mkdirSync(path.join(tmpHome, ".config", "opencode"), { recursive: true })
    const sidecar = emptyConfig()
    sidecar.agents = { explore: { parent: {}, variants: { "explore-light": { name: "explore-light", model: "opencode/muse-spark-1.3-contributor-free" } } } }
    writeFileSync(path.join(tmpHome, ".config", "opencode", "agent-variants.jsonc"), JSON.stringify(sidecar), "utf8")
    const realProfile = process.env.USERPROFILE
    const realHome = process.env.HOME
    process.env.USERPROFILE = tmpHome
    process.env.HOME = tmpHome
    try {
      const sessions = new Map([
        ["ses_parent", { id: "ses_parent", model: { providerID: "closedrouter", modelID: "glm-5.3" } }],
        ["ses_base_child", { id: "ses_base_child", parentID: "ses_parent" }],
        ["ses_variant_child", { id: "ses_variant_child", parentID: "ses_parent" }],
        ["ses_foreign_child", { id: "ses_foreign_child", parentID: "ses_other_parent" }],
        // The live runtime returns an {error} envelope WITHOUT `data` for
        // missing sessions - getData passes it through as a truthy object.
        ["ses_envelope_child", { error: "Session not found" }],
      ])
      const partsByChild = new Map([
        // Genuine old base task: no AV alias metadata.
        ["ses_base_child", { id: "prt_base", type: "tool", tool: "task", callID: "call_base", state: { status: "completed", input: { subagent_type: "explore" }, metadata: { sessionId: "ses_base_child" } } }],
        // Variant child: carries the alias (what the correlation machinery writes).
        ["ses_variant_child", { id: "prt_variant", type: "tool", tool: "task", callID: "call_variant", state: { status: "completed", input: { subagent_type: "explore-light" }, metadata: { sessionId: "ses_variant_child", agentVariants: { alias: "explore-light" } } } }],
      ])
      const fakeClient = {
        tui: { showToast: async () => true },
        session: {
          get: async ({ path }) => ({ data: sessions.get(path.id) }),
          messages: async () => ({ data: partsByChild.size > 0 ? [{ parts: [...partsByChild.values()] }] : [{ parts: [] }] }),
        },
      }
      const hooks = await __testInternals.createHooks({ client: fakeClient, directory: "C:/x" }, sidecar)
      await hooks.config({ agent: { explore: { hidden: true }, historian: { hidden: true } } })

      const expectRejection = async (label, regex, call) => {
        let rejected
        try {
          await hooks["tool.execute.before"](call[0], call[1])
          rejected = undefined
        } catch (error) {
          rejected = error
        }
        assert(rejected && regex.test(String(rejected?.message)), `${label} (got ${rejected?.message ?? "no error"})`)
      }

      // Config-hidden AV parent: fresh direct call rejected.
      await expectRejection(
        "config-hidden parent rejects fresh calls",
        /Agent "explore" is disabled - use one of its variants: explore-light/,
        [{ tool: "task", sessionID: "ses_parent", callID: "c1" }, { args: { subagent_type: "explore", prompt: "x" } }],
      )

      // Hidden agent WITHOUT a sidecar entry: never rejected (plugin agents keep working).
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: "c2" }, { args: { subagent_type: "historian", prompt: "x" } })

      // Bogus task id: rejected (v1 core would silently create a fresh session).
      await expectRejection(
        "bogus task id is rejected",
        /Unknown task id "ses_bogus" - no such session/,
        [{ tool: "task", sessionID: "ses_parent", callID: "c3" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_bogus" } }],
      )

      // Error-envelope response (missing session): the envelope has no string
      // id and must be treated as unknown, not as a truthy session.
      await expectRejection(
        "error-envelope task id is rejected",
        /Unknown task id "ses_envelope_child" - no such session/,
        [{ tool: "task", sessionID: "ses_parent", callID: "c3b" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_envelope_child" } }],
      )

      // Foreign-parent task id: rejected (hijack guard, matches v2 core behavior).
      await expectRejection(
        "foreign-parent task id is rejected",
        /belongs to a different parent session/,
        [{ tool: "task", sessionID: "ses_parent", callID: "c4" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_foreign_child" } }],
      )

      // Variant child resumed with the disabled base: rejected with the alias hint.
      await expectRejection(
        "base resume of a variant child is rejected with the alias",
        /Task ses_variant_child belongs to variant "explore-light" - resume it with explore-light/,
        [{ tool: "task", sessionID: "ses_parent", callID: "c5" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_variant_child" } }],
      )

      // Genuine old base task: resume allowed (the exemption's whole point).
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: "c6" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_base_child" } })

      // Bogus task id on a NON-hidden agent is still rejected (general task-tool guard).
      await expectRejection(
        "bogus task id rejected for any agent",
        /Unknown task id "ses_bogus2" - no such session/,
        [{ tool: "task", sessionID: "ses_parent", callID: "c7" }, { args: { subagent_type: "historian", prompt: "x", task_id: "ses_bogus2" } }],
      )

      // Enriched rejection: with session.list available, a distance-1 typo
      // gets the confident closest-match line plus the recent list.
      {
        const listed = {
          tui: { showToast: async () => true },
          session: {
            get: async () => ({ data: undefined }),
            messages: async () => ({ data: [{ parts: [] }] }),
            list: async () => ({
              data: [
                { id: "ses_child_nearmiss", parentID: "ses_parent", title: "Seek: verify W10.4", agent: "explore", time: { created: Date.now() - 3_600_000, updated: Date.now() - 600_000 } },
                { id: "ses_child_unrelated_zzzzzzzzzzzzzz", parentID: "ses_parent", title: "Other", agent: "general", time: { created: Date.now() - 100_000 } },
                { id: "ses_child_foreign", parentID: "ses_other", title: "Not mine", agent: "general", time: { created: Date.now() } },
              ],
            }),
          },
        }
        const hooks2 = await __testInternals.createHooks({ client: listed, directory: "C:/x" }, sidecar)
        let rejected
        try {
          await hooks2["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: "c8" }, { args: { subagent_type: "explore", prompt: "x", task_id: "ses_child_nearmisss" } })
        } catch (error) {
          rejected = error
        }
        const message = String(rejected?.message ?? "")
        assert(/Closest match: ses_child_nearmiss/.test(message), `distance-1 typo proposes the confident closest match (got ${message})`)
        assert(message.includes(`"Seek: verify W10.4"`), "closest-match line carries the title")
        assert(message.includes("retry with that exact id"), "confident tier wording present")
        assert(message.includes("Recent subagent sessions (newest first):"), "recent list present")
        const listSection = message.slice(message.indexOf("Recent subagent sessions"))
        assert(listSection.indexOf("ses_child_unrelated_zzzzzzzzzzzzzz") < listSection.indexOf("ses_child_nearmiss"), "list is newest-first")
        assert(!message.includes("ses_child_foreign"), "foreign-parent sessions excluded from suggestions")
      }
    } finally {
      process.env.USERPROFILE = realProfile
      process.env.HOME = realHome
      rmSync(tmpHome, { recursive: true, force: true })
    }
  }

  // --- v2 assembly: unification - hidden parent definition base-disables ---
  {
    const editor = stubV2Editor({
      build: { id: "build", name: "build", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "You are build.", description: "Build things.", mode: "all", hidden: true, color: "#3af", steps: 5, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      dreamer: { id: "dreamer", name: "dreamer", request: { settings: {}, headers: {}, body: {} }, mode: "subagent", hidden: true, permissions: [] },
    })
    const sidecar = emptyConfig()
    sidecar.agents = { build: { parent: {}, variants: { plain: { temperature: 0.2 } } } }
    const assembly = assembleV2Agents(editor, sidecar)
    assert(assembly.hiddenBaseParents.has("build"), "v2: hidden parent definition with enabled variants is base-disabled")
    assert(!assembly.hiddenBaseParents.has("dreamer"), "v2: hidden agent without a sidecar entry is never touched")
    const alias = editor.map.get("build-plain")
    assert(alias && alias.hidden === false, "v2: variant alias stays visible")
  }

  // --- v2 assembly: parent hidden, alias visible ---
  {
    const editor = stubV2Editor({
      build: { id: "build", name: "build", model: { providerID: "zai", id: "glm-5.3" }, request: { settings: {}, headers: {}, body: {} }, system: "You are build.", description: "Build things.", mode: "all", hidden: false, color: "#3af", steps: 5, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    })
    const sidecar = emptyConfig()
    sidecar.agents = { build: { parent: {}, disable_base: true, variants: { plain: { temperature: 0.2 } } } }
    const assembly = assembleV2Agents(editor, sidecar)
    const parent = editor.map.get("build")
    assert(parent.hidden === true, "v2: disable_base hides the parent definition")
    const alias = editor.map.get("build-plain")
    assert(alias && alias.hidden === false, "v2: variant alias stays visible")
    assert(assembly.aliases.has("build-plain"), "v2: variant route registered")
  }
}


// Correlation v2: tail-windowed parent fetches (never full-list), continuation
// pre-registration (zero parent fetches), stale-state safety for manual or
// automated post-call messages, and base-continuation clears.
async function testCorrelationV2() {
  const { createHooks } = __testInternals
  const messagesCalls = []
  const toasts = []
  let newPartStatus = "running"
  // liveRoute hot-reloads the sidecar from the real config dir; point HOME at
  // a temp profile so validation sees exactly this test's variant.
  const tmpHome = mkdtempSync(path.join(tmpdir(), "av-live-"))
  mkdirSync(path.join(tmpHome, ".config", "opencode"), { recursive: true })
  const sidecar = emptyConfig()
  sidecar.agents = { explore: { parent: {}, variants: { "explore-light": { name: "explore-light", model: "opencode/muse-spark-1.3-contributor-free", variant: "xhigh" } } } }
  writeFileSync(path.join(tmpHome, ".config", "opencode", "agent-variants.jsonc"), JSON.stringify(sidecar), "utf8")
  const realProfile = process.env.USERPROFILE
  const realHome = process.env.HOME
  process.env.USERPROFILE = tmpHome
  process.env.HOME = tmpHome
  const childPartFor = (child, callID) => ({
    id: `prt_${child}`, type: "tool", tool: "task", callID,
    state: { status: child === "ses_child_new" ? newPartStatus : "completed", input: { subagent_type: "explore" }, metadata: { sessionId: child } },
  })
  const sessions = new Map([
    ["ses_parent", { id: "ses_parent", model: { providerID: "closedrouter", modelID: "glm-5.3" } }],
    ["ses_child1", { id: "ses_child1", parentID: "ses_parent" }],
    ["ses_child_new", { id: "ses_child_new", parentID: "ses_parent" }],
    ["ses_ghost_child", { id: "ses_ghost_child", parentID: "ses_parent" }],
  ])
  const fakeClient = {
    tui: {
      showToast: async (payload) => {
        toasts.push(JSON.stringify(payload))
        return true
      },
    },
    session: {
      get: async ({ path }) => ({ data: sessions.get(path.id) }),
      messages: async ({ path, query }) => {
        messagesCalls.push({ path: path.id, query })
        return { data: [{ parts: [childPartFor("ses_child_new", "call_new")] }] }
      },
    },
  }
  const hooks = await createHooks({ client: fakeClient, directory: "C:/x" }, sidecar)
  await hooks.config({ agent: { explore: {} } })

  // 1) Continuation: route pre-registered from call args, applies with ZERO
  //    parent-history fetches.
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_cont" },
    { args: { subagent_type: "explore-light", prompt: "x", description: "d", sessionID: "ses_child1" } },
  )
  const cont = { message: { model: { providerID: "closedrouter", modelID: "glm-5.3" } }, parts: [] }
  await hooks["chat.message"]({ sessionID: "ses_child1", agent: "explore" }, cont)
  assert(cont.message.model.providerID === "opencode", "continuation applies the variant model")
  assert(messagesCalls.length === 0, `continuation must not fetch parent history (got ${messagesCalls.length})`)

  // 2) The call completes -> bindings released; a manual/automated message to
  //    the same child afterwards must NOT reapply the stale route.
  await hooks["tool.execute.after"]({ tool: "task", sessionID: "ses_parent", callID: "call_cont" }, { title: "t", output: "ok" })
  const manual = { message: { model: { providerID: "closedrouter", modelID: "glm-5.3" } }, parts: [] }
  await hooks["chat.message"]({ sessionID: "ses_child1", agent: "explore" }, manual)
  assert(manual.message.model.providerID === "closedrouter", "post-call manual messages keep the session model")

  // 3) New call: correlation fetches ONLY a bounded tail window.
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_new" },
    { args: { subagent_type: "explore-light", prompt: "x" } },
  )
  const fresh = { message: { model: {} }, parts: [] }
  await hooks["chat.message"]({ sessionID: "ses_child_new", agent: "explore" }, fresh)
  assert(fresh.message.model.providerID === "opencode", "new-call correlation applies the variant model")
  assert(messagesCalls.length > 0 && messagesCalls.every((c) => Number.isFinite(c.query?.limit) && c.query.limit > 0), "every parent-history fetch is tail-window limited")
  assert(messagesCalls.some((c) => c.query.limit === 16 || c.query.limit === 48), "windows use the configured sizes")

  // 4) Base continuation to a child with stale route state clears it before
  //    any message runs (no wrong-variant application).
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_cont2" },
    { args: { subagent_type: "explore-light", prompt: "x", sessionID: "ses_child1" } },
  )
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_base" },
    { args: { subagent_type: "explore", prompt: "x", sessionID: "ses_child1" } },
  )
  const afterBase = { message: { model: { providerID: "closedrouter", modelID: "glm-5.3" } }, parts: [] }
  await hooks["chat.message"]({ sessionID: "ses_child1", agent: "explore" }, afterBase)
  assert(afterBase.message.model.providerID === "closedrouter", "base continuation must not inherit the stale variant route")

  // 5) Route-object identity: a call whose model applied via the pending/
  //    correlation path must NOT trigger the never-applied diagnostic (the
  //    pending entry and the byCall route are now the same instance).
  newPartStatus = "completed"
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ses_parent", callID: "call_new", args: { subagent_type: "explore", prompt: "x" } },
    { title: "t", output: "ok", metadata: {} },
  )
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert(!toasts.some((toast) => toast.includes("never applied")), `applied call must not warn (got: ${toasts.join(" | ")})`)

  // 6) Genuine miss: route requested, no child message ever applied -> the
  //    diagnostic fires with the call id, and lands in the debug log even
  //    with debug mode off ([always] line).
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_miss" },
    { args: { subagent_type: "explore-light", prompt: "x" } },
  )
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ses_parent", callID: "call_miss", args: { subagent_type: "explore", prompt: "x" } },
    { title: "t", output: "ok", metadata: {} },
  )
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const missToast = toasts.find((toast) => toast.includes("never applied"))
  assert(missToast, "genuine correlation miss must warn")
  assert(missToast.includes("call_miss"), "the never-applied warning carries the call id")
  const debugLogText = readFileSync(path.join(tmpHome, ".config", "opencode", "agent-variants.debug.log"), "utf8")
  assert(debugLogText.includes("[always] Agent variant route never applied") && debugLogText.includes("call_miss"), "never-applied anomaly is captured unconditionally in the debug log")
  assert(debugLogText.includes("[always] diagnostic queued"), "queued warning diagnostics are captured unconditionally")

  // 7) v1 task_id resume: the model resumes a prior round's child via the
  //    `task_id` arg (v1's actual resume key). Must pre-register (zero parent
  //    fetches) and must NOT warn.
  const fetchesBeforeResume = messagesCalls.length
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_resume" },
    { args: { subagent_type: "explore-light", prompt: "resume it", task_id: "ses_child1" } },
  )
  const resumeOut = { message: { model: { providerID: "closedrouter", modelID: "glm-5.3" } }, parts: [] }
  await hooks["chat.message"]({ sessionID: "ses_child1", agent: "explore" }, resumeOut)
  assert(resumeOut.message.model.providerID === "opencode", "task_id resume applies the variant model")
  assert(messagesCalls.length === fetchesBeforeResume, "task_id resume correlates without parent fetches")
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ses_parent", callID: "call_resume", args: { subagent_type: "explore" } },
    { title: "t", output: "ok", metadata: {} },
  )

  // 8) Ghost-warning suppression: a prior round's RUNNING part for the same
  //    child (alias in metadata) + a live call for that alias -> the alias
  //    fallback must resolve to the LIVE call instance so appliedCount is
  //    visible to that call's after-hook.
  const ghostPart = {
    id: "prt_old_round", type: "tool", tool: "task", callID: "call_old_round",
    state: { status: "running", input: { subagent_type: "explore" }, metadata: { sessionId: "ses_ghost_child", agentVariants: { alias: "explore-light" } } },
  }
  const messagesBase = fakeClient.session.messages
  fakeClient.session.messages = async ({ path, query }) => {
    messagesCalls.push({ path: path.id, query })
    return { data: [{ parts: [ghostPart] }] }
  }
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "ses_parent", callID: "call_ghost" },
    { args: { subagent_type: "explore-light", prompt: "x" } },
  )
  const ghostOut = { message: { model: { providerID: "closedrouter", modelID: "glm-5.3" } }, parts: [] }
  await hooks["chat.message"]({ sessionID: "ses_ghost_child", agent: "explore" }, ghostOut)
  assert(ghostOut.message.model.providerID === "opencode", "alias fallback applies the variant model via the prior part")
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ses_parent", callID: "call_ghost", args: { subagent_type: "explore" } },
    { title: "t", output: "ok", metadata: {} },
  )
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const ghostToast = toasts.find((toast) => toast.includes("never applied") && toast.includes("call_ghost"))
  assert(!ghostToast, `live-call alias fallback must not produce a ghost never-applied warning (got: ${ghostToast})`)

  process.env.USERPROFILE = realProfile
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
}
await testHistoryRepairSkipsRunningParts()

function testSelfwire() {
  // Identity matching: npm specs AND local checkout folders.
  assert(isAgentVariantsSpec("@mirrowel/opencode-agent-variants"), "npm spec matches")
  assert(isAgentVariantsSpec("@mirrowel/opencode-agent-variants@dev"), "tagged npm spec matches")
  assert(isAgentVariantsSpec("file:///C:/Projects/OC%20Plugins/agent-variants"), "local checkout folder matches")
  assert(isAgentVariantsSpec("file:///C:/cache/@mirrowel/opencode-agent-variants@dev"), "cache folder matches")
  assert(!isAgentVariantsSpec("@mirrowel/opencode-config-studio"), "studio spec does not match")
  assert(!isAgentVariantsSpec("file:///C:/Projects/OC%20Plugins/opencode-config-studio"), "studio folder does not match")
  assert(isConfigStudioSpec("file:///C:/Projects/OC%20Plugins/opencode-config-studio"), "studio folder detected")
  assert(isConfigStudioSpec("@mirrowel/opencode-config-studio@latest"), "studio npm detected")

  // No registration -> no-op.
  {
    const dir = mkdtempSync(join(tmpdir(), "av-selfwire-"))
    const globalDir = join(dir, "global")
    mkdirSync(globalDir, { recursive: true })
    try {
      writeFileSync(join(globalDir, "opencode.json"), JSON.stringify({ plugin: ["@cortexkit/other"] }), "utf8")
      const result = ensureTuiRegistration({ env: { OPENCODE_CONFIG_DIR: globalDir } })
      if (result.status !== "not-registered") throw new Error(`expected not-registered, got ${result.status}`)
      if (existsSync(join(globalDir, "tui.json"))) throw new Error("tui.json must not be created")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Studio present anywhere -> stands down even with AV registered.
  {
    const dir = mkdtempSync(join(tmpdir(), "av-selfwire-"))
    const globalDir = join(dir, "global")
    mkdirSync(globalDir, { recursive: true })
    try {
      writeFileSync(
        join(globalDir, "opencode.json"),
        JSON.stringify({ plugin: ["@mirrowel/opencode-agent-variants", "file:///C:/somewhere/opencode-config-studio"] }),
        "utf8",
      )
      const result = ensureTuiRegistration({ env: { OPENCODE_CONFIG_DIR: globalDir } })
      if (result.status !== "skipped-studio") throw new Error(`expected skipped-studio, got ${result.status}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Mirrors the registration level; local wins over npm; already-wired is a
  // no-op; stale/mismatched mirrors auto-correct.
  {
    const dir = mkdtempSync(join(tmpdir(), "av-selfwire-"))
    const globalDir = join(dir, "global")
    const project = join(dir, "project", "src")
    const localRepo = join(dir, "agent-variants")
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(project, { recursive: true })
    mkdirSync(localRepo, { recursive: true })
    const localSpec = pathToFileURL(localRepo).href
    try {
      writeFileSync(join(globalDir, "opencode.json"), JSON.stringify({ plugin: ["@cortexkit/other", "@mirrowel/opencode-agent-variants@latest", localSpec] }), "utf8")
      writeFileSync(join(globalDir, "tui.json"), JSON.stringify({ plugin: ["@cortexkit/magic"] }), "utf8")

      const first = ensureTuiRegistration({ env: { OPENCODE_CONFIG_DIR: globalDir } })
      if (first.status !== "wired" || first.spec !== localSpec) throw new Error(`local must win: ${JSON.stringify(first)}`)
      const tui = JSON.parse(readFileSync(join(globalDir, "tui.json"), "utf8"))
      if (!tui.plugin.includes(localSpec) || !tui.plugin.includes("@cortexkit/magic")) throw new Error(`wire keeps foreign entries: ${JSON.stringify(tui.plugin)}`)

      const second = ensureTuiRegistration({ env: { OPENCODE_CONFIG_DIR: globalDir } })
      if (second.status !== "already-wired") throw new Error(`idempotent: ${second.status}`)

      // Mismatch correction: tui carries npm while server prefers local.
      writeFileSync(join(globalDir, "tui.json"), JSON.stringify({ plugin: ["@cortexkit/magic", "@mirrowel/opencode-agent-variants@dev", "@mirrowel/opencode-agent-variants@latest"] }), "utf8")
      const third = ensureTuiRegistration({ env: { OPENCODE_CONFIG_DIR: globalDir } })
      if (third.status !== "corrected") throw new Error(`expected corrected, got ${third.status}`)
      const fixed = JSON.parse(readFileSync(join(globalDir, "tui.json"), "utf8"))
      const own = fixed.plugin.filter((entry) => isAgentVariantsSpec(entry))
      if (own.length !== 1 || own[0] !== localSpec) throw new Error(`dedup + local alignment failed: ${JSON.stringify(fixed.plugin)}`)

      // Project-level registration mirrors to the project tui.json.
      writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugin: [localSpec] }), "utf8")
      rmSync(join(globalDir, "opencode.json"))
      const fourth = ensureTuiRegistration({ env: { OPENCODE_CONFIG_DIR: globalDir }, directory: project, worktree: join(dir, "project") })
      if (fourth.status !== "corrected" && fourth.status !== "wired") throw new Error(`project mirror failed: ${JSON.stringify(fourth)}`)
      const projectTui = JSON.parse(readFileSync(join(project, "tui.json"), "utf8"))
      if (!projectTui.plugin.includes(localSpec)) throw new Error(`project tui must carry the spec: ${JSON.stringify(projectTui)}`)
      const globalTui = JSON.parse(readFileSync(join(globalDir, "tui.json"), "utf8"))
      if (globalTui.plugin.some((entry) => isAgentVariantsSpec(entry))) throw new Error(`stale global mirror must be pruned: ${JSON.stringify(globalTui)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function testEmbeddedDialogScope() {
  // Embedded scope (Config Studio): applyWizardUiSettings must NOT push
  // sidecar ui values into the host kv - the host's dialog settings rule.
  const record = []
  const config = emptyConfig()
  config.ui = { width: "xlarge", height: "max", height_percent: 100 }
  const makeApi = (scope) => ({
    dialogScope: scope,
    kv: { get: (_key, fallback) => fallback, set: (key, value) => record.push([key, value]), ready: true },
    ui: { dialog: { setSize: (size) => record.push(["setSize", size]) } },
  })
  applyWizardUiSettings(makeApi("standalone"), config)
  if (record.length === 0) throw new Error("standalone scope must push ui settings into kv")
  if (!record.some(([key]) => key === "agent-variants.ui-width")) throw new Error(`standalone scope writes own keys: ${JSON.stringify(record)}`)
  record.length = 0
  applyWizardUiSettings(makeApi("embedded"), config)
  if (record.length !== 0) throw new Error(`embedded scope must not touch kv/setSize: ${JSON.stringify(record)}`)
}

testSelfwire()
testEmbeddedDialogScope()

// --- unknown-task-id suggestions (tiered fuzzy match + list) ---

function testUnknownTaskIdSuggestions() {
  // levenshteinWithin basics.
  if (levenshteinWithin("ses_pzh4v", "ses_pzh4v4", 1) !== 1) throw new Error("levenshtein: one extra char is distance 1")
  if (levenshteinWithin("ses_abc", "ses_abd", 2) !== 1) throw new Error("levenshtein: substitution is distance 1")
  if (levenshteinWithin("ses_abc", "ses_xyz", 2) !== undefined) throw new Error("levenshtein: beyond max returns undefined")

  const near = [{ id: "ses_f595127c9ffeeenrCSx2Lpzh4v", title: "Seek: verify W10.4", agent: "explore-seek", updated: Date.now() - 3_600_000 }]
  // The user's real case: one char too many -> confident tier.
  {
    const message = buildUnknownTaskIdMessage("ses_f595127c9ffeeenrCSx2Lpzh4v4", near, { typoDistance: 3, suggestLimit: 10 })
    if (!message.includes("Closest match: ses_f595127c9ffeeenrCSx2Lpzh4v")) throw new Error(`distance-1 typo must be a confident match (got ${message})`)
    if (!message.includes("retry with that exact id")) throw new Error("confident tier wording")
    if (!message.includes("1h ago")) throw new Error("candidate age rendered")
  }
  // Distance 3 (within outer bound, beyond confident bound) -> fuzzy tier.
  {
    const message = buildUnknownTaskIdMessage("ses_f595127c9ffeeenrCSx2Lpzh4xyz", near, { typoDistance: 3, suggestLimit: 10 })
    if (!message.includes("Possible match (fuzzy): ses_f595127c9ffeeenrCSx2Lpzh4v")) throw new Error(`distance-3 typo must be fuzzy (got ${message})`)
    if (!message.includes("verify the title before resuming")) throw new Error("fuzzy tier wording")
  }
  // Distance 4 (beyond bound) -> explicit no-close-match note, list still there.
  {
    const message = buildUnknownTaskIdMessage("ses_f595127c9ffeeenrCSx2Lpqxyz", near, { typoDistance: 3, suggestLimit: 10 })
    if (!message.includes("No close match found")) throw new Error("beyond-bound typo notes no close match")
    if (!message.includes("Recent subagent sessions")) throw new Error("list survives a failed match")
  }
  // typoDistance 0 disables matching but keeps the list; suggestLimit 0 the reverse.
  {
    const noMatch = buildUnknownTaskIdMessage("ses_f595127c9ffeeenrCSx2Lpzh4v4", near, { typoDistance: 0, suggestLimit: 10 })
    if (noMatch.includes("Closest match") || noMatch.includes("Possible match")) throw new Error("typoDistance 0 disables matching")
    if (!noMatch.includes("Recent subagent sessions")) throw new Error("typoDistance 0 keeps the list")
    const noList = buildUnknownTaskIdMessage("ses_f595127c9ffeeenrCSx2Lpzh4v4", near, { typoDistance: 3, suggestLimit: 0 })
    if (!noList.includes("Closest match")) throw new Error("suggestLimit 0 keeps matching")
    if (noList.includes("Recent subagent sessions")) throw new Error("suggestLimit 0 disables the list")
  }
  // Cap + newest-first ordering.
  {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `ses_c${String(index).padStart(2, "0")}`, created: Date.now() - index * 1000 }))
    const message = buildUnknownTaskIdMessage("ses_totally_bogus_no_match", many, { typoDistance: 3, suggestLimit: 10 })
    const section = message.slice(message.indexOf("Recent subagent sessions"))
    if (section.includes("ses_c11")) throw new Error("list capped at 10 excludes the oldest")
    if (!section.includes("ses_c00") || section.indexOf("ses_c00") > section.indexOf("ses_c01")) throw new Error("list is newest-first")
  }
  // Truncation class: bogus is a strict prefix of the real id. Confident
  // regardless of edit distance within the bound, tailored wording, alias
  // replaces the parent agent, annotation stripped from the title.
  {
    const real = [{ id: "ses_f58bc8e97ffe9LtnJ3JJ6u9Q7J", title: "Embeddings research — seek (@explore-seek variant)", agent: "explore", updated: Date.now() - 3_600_000 }]
    const message = buildUnknownTaskIdMessage("ses_f58bc8e97ffe9LtnJ3JJ6u9Q", real, { typoDistance: 3, suggestLimit: 10 })
    if (!message.includes("id looks truncated - full id: ses_f58bc8e97ffe9LtnJ3JJ6u9Q7J")) throw new Error(`2-char truncation gets the truncated-class wording (got ${message})`)
    if (!message.includes(`"Embeddings research — seek" - explore-seek`)) throw new Error(`alias replaces parent agent, annotation stripped (got ${message})`)
    if (message.includes("(@explore-se")) throw new Error("no dangling partial annotation survives")
    if (message.includes("- explore -")) throw new Error("parent agent dropped when alias known")
  }
  // 3-char truncation: prefix evidence is confident even beyond the 2-edit
  // substitution bound (was fuzzy before the prefix tier).
  {
    const real = [{ id: "ses_real_child_abcde", title: "T", agent: "explore" }]
    const message = buildUnknownTaskIdMessage("ses_real_child_ab", real, { typoDistance: 3, suggestLimit: 10 })
    if (!message.includes("id looks truncated - full id: ses_real_child_abcde")) throw new Error(`3-char truncation is confident (got ${message})`)
    if (message.includes("Possible match")) throw new Error("3-char truncation must not fall to the fuzzy tier")
  }
  // 5-char truncation: beyond the bound entirely - no proposal, list only.
  {
    const real = [{ id: "ses_real_child_abcde", title: "T", agent: "explore" }]
    const message = buildUnknownTaskIdMessage("ses_real_child", real, { typoDistance: 3, suggestLimit: 10 })
    if (message.includes("truncated") || message.includes("Closest match") || message.includes("Possible match")) throw new Error(`beyond-bound truncation gets no proposal (got ${message})`)
    if (!message.includes("No close match found")) throw new Error("beyond-bound truncation notes no close match")
    if (!message.includes("Recent subagent sessions")) throw new Error("list still present for beyond-bound truncation")
  }
  // Word-boundary title truncation: no mid-token cuts, no dangling "(@...".
  {
    const long = [{ id: "ses_wordy_child", title: "Investigate the routing table regression reported in W10.4 (@explore-light variant)", agent: "explore" }]
    const message = buildUnknownTaskIdMessage("ses_wordy_childe", long, { typoDistance: 3, suggestLimit: 10 })
    if (message.includes("(@explore")) throw new Error("annotation must be stripped, never partially shown")
    if (!message.includes("- explore-light")) throw new Error(`stripped alias replaces the parent agent (got ${message})`)
    const quoted = message.match(/"([^"]*)…"/)
    if (quoted && /\S…$/.test(quoted[1])) throw new Error(`ellipsis must cut at a word boundary (got "${quoted[0]}")`)
  }
  // No candidates at all -> terse fallback shape.
  {
    const message = buildUnknownTaskIdMessage("ses_nope", [], { typoDistance: 3, suggestLimit: 10, variantsHint: true })
    if (!message.includes('Unknown task id "ses_nope" - no such session.')) throw new Error("terse first line")
    if (!message.includes("(or use one of its variants)")) throw new Error("variants hint respected")
    if (message.includes("No close match found")) throw new Error("no-candidate case skips the no-match note")
  }
}

testUnknownTaskIdSuggestions()
console.log("regression tests passed")
process.exit(0)
