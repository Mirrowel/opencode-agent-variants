import { readFileSync } from "node:fs"
import { __testAssembleAgents, __testInternals } from "../dist/index.js"
import { emptyConfig, inferredSelectionPreset, SELECTION_PRESETS, SidecarConfig, profileMatchesModel, resolveActiveProfile, overlayProfilePatch, profileVariantPatch, profileParentPatch, profileFieldSource, setProfileFieldIn } from "../dist/config.js"
import { currentPaletteCategory, declarePaletteCategory, reconcilePaletteCategories, __resetPaletteRegistry } from "../dist/palette-category.js"
import { isAgentVariantsSpec, isConfigStudioSpec, ensureTuiRegistration } from "../dist/selfwire.js"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
const path = { join, sep }
import { pathToFileURL } from "node:url"

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

testProfiles()
testPaletteCategory()
testPartialProviderOverrideWithVariants()
testMissingCustomProviderModelIsDeferred()
testMalformedModelShapeStillSkips()
testMarkerlessDefaultAndLegacyScrub()
testParallelBaseTaskCannotClaimVariantRoute()
testRuntimeDependencyMetadata()
testSelectionTierInference()
await testLiveRepairNeverRevertsRunningParts()
await testHistoryRepairSkipsRunningParts()

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

testSelfwire()
await testLiveRepairNeverRevertsRunningParts()
await testHistoryRepairSkipsRunningParts()

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

await testCorrelationV2()

console.log("regression tests passed")
process.exit(0)
