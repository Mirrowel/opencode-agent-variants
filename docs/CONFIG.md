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

Parent overrides are local to the parent by default. A parent can opt in to sharing a field with variants through `parent.propagate.<field>`. A variant accepts propagated fields by default, and can opt out per field through `variant.inherit.<field> = false`.

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

Hot-reloadable fields for existing aliases:

- `model`
- `variant`
- `temperature`
- `top_p`
- `prompt`
- `prompt_prepend`
- `prompt_append`
- `options`

Fields/actions that require an OpenCode restart because they affect cached task-list or UI metadata:

- adding/deleting/enabling/disabling variants
- `name`
- `description`
- `description_prepend`
- `description_append`
- `color`

Variants also support:

- `name`: custom generated agent name. Defaults to `${parent}-${variantKey}`.

The sidecar intentionally does not configure `permission`, `tools`, or `mode`. Those come from the parent.

## Inheritance And Propagation

Parent propagation and variant inheritance are field-level controls:

```jsonc
"agents": {
  "general": {
    "parent": {
      "temperature": 0.2,
      "propagate": {
        "temperature": true
      }
    },
    "variants": {
      "light": {
        "model": "light",
        "inherit": {
          "temperature": true,
          "prompt_append": false
        }
      }
    }
  }
}
```

A variant receives a parent field only when all of these are true:

- `parent.propagate.<field>` is `true`
- `variant.inherit.<field>` is not `false`
- the variant does not set a local value for that field

Variant local values always win. Parent propagation defaults to off. Variant inheritance defaults to on.

The wizard shows compact field indicators:

- `PROP:on/off` for parent propagation
- `INH:on/off` for variant inheritance
- `SRC:local/inherit/none` for the value source

Use `Inspect field` in the field action menu to see local value, inherited value, resulting value, and whether the field hot-reloads or requires restart. Submitting an empty field value removes the local override; pressing escape cancels.

Agent Variants are intended for agents callable by OpenCode's `task` tool. The wizard defaults to a subagent-capable parent filter (`mode: "subagent"` or `mode: "all"`) and hides primary-only agents from add/edit parent pickers. This is a wizard-only setting, not a sidecar field. Existing sidecar entries for primary-only parents still appear in edit/delete/toggle flows so they can be repaired.

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
- variant model is definitely missing,
- parent is primary-only and will not be callable by `task`.

Run `Agent Variants: Configure` -> `Run diagnostics` to inspect these issues.

## Debug Log

Debug logs are written to:

```txt
~/.config/opencode/agent-variants.debug.log
```

The wizard can view or clear this log.
