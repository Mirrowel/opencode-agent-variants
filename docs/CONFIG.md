# Agent Variants Config

The plugin reads `~/.config/opencode/agent-variants.jsonc`. This sidecar file is separate from `opencode.json`; OpenCode config remains the source of truth for providers, base agents, permissions, and built-in behavior.

See `agent-variants.example.jsonc` for a fully commented starter file.

## Top-Level Fields

- `debug`: boolean. Enables routing/model diagnostic toasts and file logging. This is hot-read by the server plugin, so toggling it from the wizard takes effect immediately for future variant calls.
- `models`: named model shortcuts. Each shortcut has `model` and optional `label`.
- `agents`: parent-agent entries. Each key is a built-in or configured OpenCode agent name.

## Model Shortcuts

```jsonc
"models": {
  "light": {
    "model": "zai-coding-plan/glm-5.1",
    "label": "GLM 5.1"
  }
}
```

Variant `model` fields can use either `"light"` or the full `"provider/model"` reference.

If a variant resolves to a model that is definitely missing, the plugin skips that variant at startup and shows a warning toast. The sidecar is not modified automatically.

## Parent Entries

```jsonc
"agents": {
  "general": {
    "disable": false,
    "parent": {},
    "variants": {}
  }
}
```

- `disable`: disables this sidecar parent and all its variants.
- `parent`: optional field overrides for the parent agent.
- `variants`: generated variants grouped under this parent.

Parent overrides apply only when the parent has at least one enabled variant.

## Supported Override Fields

Parents and variants support:

- `model`
- `variant`
- `temperature`
- `top_p`
- `prompt`
- `prompt_prepend`
- `prompt_append`
- `description`
- `description_prepend`
- `description_append`
- `options`
- `color`
- `disable`

Variants also support:

- `name`: custom generated agent name. Defaults to `${parent}-${variantKey}`.

The sidecar intentionally does not configure `permission`, `tools`, or `mode`. Those come from the parent.

## Description Generation

If a variant does not set `description`, the plugin generates:

```txt
Copy of the <parent> agent using <model label>.
```

Then it applies `description_prepend` and `description_append`.

## Template Variables

The following variables work in description and prompt fields:

- `{parent}`: parent agent name, such as `general`
- `{alias}`: generated variant name, such as `general-light`
- `{variant_key}`: variant key, such as `light`
- `{model}`: resolved provider/model reference
- `{model_label}`: model shortcut label or resolved model reference
- `{routed_agent}`: native routed agent for built-ins, usually the parent

Example:

```jsonc
"description_append": "Use {alias} when {parent} does not need the strongest model. Runs on {model_label}."
```

## Built-In Agents

Built-in agents such as `general` and `explore` cannot be externally copied without vendoring OpenCode internals. Their variants are virtual aliases:

- the variant appears in the task tool list,
- the main model calls `task` once with the variant name,
- the plugin routes execution to the native parent,
- model/request/prompt overrides are applied,
- task output is annotated with `agent_variant`, `routed_agent`, and `effective_model`.

This preserves native prompts and permissions while making variant selection clear in the transcript.

## Config Or Markdown Agents

Agents defined in OpenCode config or agent markdown can be copied directly. Their variants are real generated config agents with supported overrides applied.

## Conflict And Validation Rules

The plugin skips problematic variants instead of producing ambiguous agents:

- parent is disabled in sidecar or OpenCode config,
- parent is unknown,
- variant alias equals parent name,
- two variants generate the same alias,
- generated alias conflicts with an existing agent,
- variant model is definitely missing.

Run `Agent Variants: Configure` -> `Run diagnostics` to inspect these issues.

## Debug Log

Debug logs are written to:

```txt
~/.config/opencode/agent-variants.debug.log
```

The wizard can view or clear this log.
