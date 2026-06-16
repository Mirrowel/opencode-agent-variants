# Agent Variants Config

The plugin reads `~/.config/opencode/agent-variants.jsonc`. This sidecar file is separate from `opencode.json`; OpenCode config remains the source of truth for providers, base agents, permissions, and built-in behavior.

See `agent-variants.example.jsonc` for a fully commented starter file.

## Top-Level Fields

- `debug`: boolean. Enables routing/model diagnostic toasts and file logging. This is hot-read by the server plugin, so toggling it from the wizard takes effect immediately. When disabled, debug toasts and debug log writes are suppressed.
- `routing`: runtime routing preferences. `routing.prompt_markers` defaults to `false`; the default markerless path correlates child sessions through OpenCode task metadata and avoids putting random route tokens in prompts. Enable prompt markers only as a legacy debug fallback.
- `ui`: wizard display preferences. `width` is `medium`, `large`, or `xlarge`; `height_percent` is a fine-grained max-height percentage clamped to 25-100. `height` is kept as a preset/reference fallback (`compact` = 32, `normal` = 50, `tall` = 68, `max` = 100).
- `models`: named model presets. Each preset has `model` and can also provide `label`, `variant`, `temperature`, `top_p`, and `options`.
- `agents`: parent-agent entries. Each key is a built-in or configured OpenCode agent name.

Debug, routing-toggle, and UI-only saves do not create backup entries. Meaningful config saves are backed up in `~/.config/opencode/agent-variants.backup.json` as a reverse-patch journal, capped to the latest 50 patch restore points. The wizard's `Debug & advanced` > `Config backups` menu can create full snapshots, preview valid restore points, restore them, optionally create a full backup before restore, and delete full snapshots. Full snapshots are not auto-pruned.

## Model Shortcuts

```jsonc
"models": {
  "light": {
    "model": "zai-coding-plan/glm-5.1",
    "label": "GLM 5.1",
    "variant": "low",
    "temperature": 0.2,
    "top_p": 0.95,
    "options": { "reasoningEffort": "low" }
  }
}
```

Parent and variant `model` fields can use either `"light"` or the full `"provider/model"` reference. Selecting a preset applies its model-related fields; local parent/variant fields still win. For example, `model: "light"` can supply `temperature: 0.2`, but a variant with its own `temperature` uses the variant value.

Malformed model references are skipped at startup. Provider/model existence is checked later against OpenCode's merged provider catalog because built-in provider config can be a partial override, not the full model list. Missing models are reported as warning toasts when the catalog is available, and invalid runtime calls fail before launching the subagent.

## Routing Settings

```jsonc
"routing": {
  "prompt_markers": false
}
```

- `prompt_markers`: legacy correlation fallback. Defaults to `false`.

With the default markerless path, the plugin matches child sessions back to variant calls through OpenCode's stored task metadata (`sessionId`) and the original task call ID. This avoids adding random route markers to prompts and is better for prompt-cache stability.

When `prompt_markers` is `true`, the plugin also appends a hidden HTML route marker to the task prompt and strips it before model replay/storage. This path is kept as a debug fallback only.

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

Press `i` on a field to see local value, inherited value, resulting value, and whether the field hot-reloads or requires restart. Submitting an empty field value removes the local override; pressing escape cancels.

Agent Variants are intended for agents callable by OpenCode's `task` tool. The wizard defaults to a subagent-capable parent filter (`mode: "subagent"` or `mode: "all"`) and hides primary-only agents from add/edit parent pickers. This is a wizard-only setting, not a sidecar field. Existing sidecar entries for primary-only parents still appear in edit/delete/toggle flows so they can be repaired.

## Description Generation

If a variant does not set `description`, the plugin generates:

```txt
Variant agent <alias>. Runs the <parent> workflow using <model label>. <selection guidance>
```

Selection guidance comes from built-in variant-intent presets. If `description` is not set, the plugin infers guidance from the variant key, alias, model preset key, resolved model name, model label, and provider model variant.

Built-in presets cover light/low-cost variants (`light`, `lite`, `flash`, `haiku`, `small`, `mini`, `nano`, etc.), heavy/strong variants, verification/second-opinion variants, parallel comparison, strict review, conservative/minimal-change passes, creative alternatives, and synthesis. Press `i` on a preset in the wizard to see its full guidance text and the Description value it will insert.

If `description` is manually set, it replaces the generated base text. While editing `description`, press `ctrl+p` to insert a preset-generated Description value, or choose Auto to remove the local `description` and rely on built-in inference. Then `description_prepend` and `description_append` apply around the base text. Parent descriptions also receive a small safe appended note listing available variant aliases so models are more likely to call the exact alias requested by the user.

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
- route metadata stays internal and model-visible task history is scrubbed of plugin-only fields. When old polluted task-tool history is found, the plugin attempts to repair the stored task part so the same cleanup is not needed again. Plain text history is only scrubbed in the replay copy, not rewritten on disk.

This preserves native prompts and permissions while keeping variant selection clear through the alias and a small natural task-title hint, without exposing internal route fields to the model.

## Config Or Markdown Agents

Agents defined in OpenCode config or agent markdown can be copied directly. Their variants are real generated config agents with supported overrides applied.

## Conflict And Validation Rules

The plugin skips problematic variants instead of producing ambiguous agents:

- parent is disabled in sidecar or OpenCode config,
- parent is unknown,
- variant alias equals parent name,
- two variants generate the same alias,
- generated alias conflicts with an existing agent,
- variant model reference is malformed and cannot be resolved to `provider/model` format.

Provider/model existence is validated after OpenCode exposes its merged provider catalog. This matters because built-in providers can have config overrides, and raw `opencode.json` provider entries are not the full model list. Post-merge model warnings are shown as toasts when possible and invalid hot-reloaded variants fail before execution once the merged catalog is available.

Diagnostics also warn about non-skipping issues:

- broken or unused model presets,
- missing provider/model references after OpenCode provider merge,
- invalid parent model overrides,
- unknown `parent.propagate` or `variant.inherit` keys,
- suspicious alias names with whitespace or control characters,
- parent is primary-only and may not be callable by `task`,
- backup journal parse/hash-chain problems.

Run `Agent Variants: Configure` -> `Run diagnostics` to inspect these issues.

## Backups

Backups are stored in:

```txt
~/.config/opencode/agent-variants.backup.json
```

Patch restore points are reverse patches from the current config back to a previous config state. The plugin validates hashes before previewing/restoring a patch point so manual sidecar edits do not silently corrupt history. Restoring a patch point removes the consumed patches, effectively moving the journal back in time.

Full backups are complete config snapshots. They are created manually from `Debug & advanced` -> `Config backups` or optionally before a restore. They are not auto-pruned and can be deleted individually with double `ctrl+d` or all at once from the backup menu.

## Debug Log

Debug logs are written to:

```txt
~/.config/opencode/agent-variants.debug.log
```

The wizard can view or clear this log.
