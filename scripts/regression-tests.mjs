import { readFileSync } from "node:fs"
import { __testAssembleAgents, __testInternals } from "../dist/index.js"
import { emptyConfig, inferredSelectionPreset, SELECTION_PRESETS, SidecarConfig, profileMatchesModel, resolveActiveProfile, overlayProfilePatch, profileVariantPatch, profileParentPatch, profileFieldSource, setProfileFieldIn } from "../dist/config.js"
import { currentPaletteCategory, declarePaletteCategory, reconcilePaletteCategories, __resetPaletteRegistry } from "../dist/palette-category.js"

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

  // Reconcile is idempotent and repairs stale categories.
  avCommand.category = "stale"
  reconcilePaletteCategories()
  assert(avCommand.category === expected, "reconcile repairs stale categories")

  __resetPaletteRegistry()
  assert(currentPaletteCategory() === "", "reset clears the registry")
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
  ]

  for (const test of cases) {
    const actual = inferredSelectionPreset("explore", test.key, { model: test.model, variant: test.variant }, config)?.key
    assert(actual === test.expected, `${test.label} should infer ${test.expected}, got ${actual ?? "none"}`)
  }

  const providerToken = inferredSelectionPreset("explore", "tier", { model: "sol/generic-model" }, config)
  assert(providerToken === undefined, "provider names must not be interpreted as model capability tiers")
  const semanticTaskName = inferredSelectionPreset("explore", "data-entry", { model: "vendor/generic-model" }, config)
  assert(semanticTaskName?.key === "basic", "semantic task names should provide a fallback when model capability is unknown")
  assert(SELECTION_PRESETS[0]?.key === "basic", "basic should be the first capability preset below light")
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

testProfiles()
testPaletteCategory()
testPartialProviderOverrideWithVariants()
testMissingCustomProviderModelIsDeferred()
testMalformedModelShapeStillSkips()
testMarkerlessDefaultAndLegacyScrub()
testParallelBaseTaskCannotClaimVariantRoute()
testRuntimeDependencyMetadata()
testSelectionTierInference()

console.log("regression tests passed")
