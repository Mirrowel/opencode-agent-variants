import { readFileSync } from "node:fs"
import { __testAssembleAgents, __testInternals } from "../dist/index.js"
import { emptyConfig, inferredSelectionPreset, SELECTION_PRESETS } from "../dist/config.js"

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

testPartialProviderOverrideWithVariants()
testMissingCustomProviderModelIsDeferred()
testMalformedModelShapeStillSkips()
testMarkerlessDefaultAndLegacyScrub()
testRuntimeDependencyMetadata()
testSelectionTierInference()

console.log("regression tests passed")
