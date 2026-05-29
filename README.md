# OpenCode Agent Variants

OpenCode Agent Variants creates model-specific versions of your agents without copying prompts by hand.

Use it when you want the main model to choose between agents like:

- `general` for the default or strongest model
- `general-light` for a cheaper/faster model
- `explore` for normal codebase exploration
- `explore-light` for routine exploration on a smaller model

The plugin adds generated variants to OpenCode's normal `task` tool list and provides one TUI wizard for editing the variant config.

## Features

- Generate variants from existing agents with model, temperature, prompt, description, options, and color overrides.
- Keep OpenCode's built-in agent prompts and permissions up to date by routing built-in variants to their native parent agent.
- Create real copied variants for agents defined in config or markdown.
- Manage variants from a single TUI command: `Agent Variants: Configure`.
- Store all plugin settings in a sidecar file instead of editing `opencode.json` for every variant.
- Avoid agent-tool pollution: the plugin does not register management tools for the assistant.

## Install

Install it with OpenCode's plugin installer:

```sh
opencode plugin opencode-agent-variants --global
```

The installer detects both plugin targets and updates the right config files:

- server target in `opencode.json` or `opencode.jsonc`
- TUI target in `tui.json` or `tui.jsonc`

Restart OpenCode after installation.

## Manual Install

If you prefer to configure it manually, add the package to your OpenCode config:

```jsonc
{
  "plugin": ["opencode-agent-variants"]
}
```

And add the same package to your TUI config:

```jsonc
{
  "plugin": ["opencode-agent-variants"]
}
```

For local development, use a file URL or local path instead of the npm package name.

## Wizard

Open the wizard from the command palette:

```txt
Agent Variants: Configure
```

If your TUI build exposes plugin slash commands, you can also run:

```txt
/agent-variants
```

The wizard supports:

- adding variants
- editing parent overrides
- editing variant overrides
- enabling or disabling parents and variants
- toggling debug mode
- running diagnostics
- viewing and clearing the debug log
- deleting variants
- previewing the generated config
- saving changes with timestamped backups

Agent/variant list changes take effect after restarting OpenCode because agents and plugins are assembled at startup. Debug mode is hot-read and takes effect immediately after the wizard saves it.

## Config File

The plugin writes a sidecar config file at:

```txt
~/.config/opencode/agent-variants.jsonc
```

This file is separate from `opencode.json`. Your normal OpenCode config remains the source of truth for providers, base agents, permissions, and any explicit model overrides you already have.

See `docs/CONFIG.md` for the complete config reference and `agent-variants.example.jsonc` for a fully commented starter file.

## Example

```jsonc
{
  "debug": false,
  "models": {
    "light": {
      "model": "zai-coding-plan/glm-5.1",
      "label": "GLM 5.1"
    }
  },
  "agents": {
    "general": {
      "parent": {
        "description_append": "Uses the default smartest model. Expensive; use for hard tasks."
      },
      "variants": {
        "light": {
          "model": "light",
          "description_append": "Use for most tasks that do not need the best model."
        }
      }
    },
    "explore": {
      "parent": {
        "description_append": "Uses the default smartest model. Use for difficult investigations."
      },
      "variants": {
        "light": {
          "model": "light",
          "description_append": "Use for most code search, reading, and exploration tasks."
        }
      }
    }
  }
}
```

Variant names default to `${parent}-${variantKey}`. In the example above, `general` plus variant key `light` becomes `general-light`.

Description and prompt fields support template variables such as `{parent}`, `{alias}`, `{variant_key}`, `{model}`, `{model_label}`, and `{routed_agent}`.

## Supported Fields

Parents and variants support these fields:

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

- `name`

`permission`, `tools`, and `mode` are inherited from the parent and are intentionally not configured in the sidecar.

## Built-In Agents

Built-in agents such as `general` and `explore` cannot be copied externally without vendoring OpenCode internals. For these agents, the plugin creates a virtual alias:

- The variant appears in the task tool list.
- The main model can call `task` once with the variant name.
- The plugin routes the call to the native parent before execution.
- The plugin applies configured model, request parameter, and explicit prompt overrides.
- The plugin annotates task result metadata/output with the selected variant alias, routed native agent, and effective model.

This preserves native prompts and permissions. The child session may internally show the parent agent name for built-in variants; that is expected.

## Config Agents

Agents defined in `opencode.json`, `.opencode/agent/*.md`, or global agent markdown can be copied directly. Their variants are real generated config agents with the supported overrides applied.

## Disable Rules

- If the parent is disabled in OpenCode config, variants are skipped.
- If a sidecar parent has `disable: true`, the parent override and all variants are skipped.
- If a variant has `disable: true`, only that variant is skipped.
- Parent overrides apply only when the parent has at least one enabled variant.
- If a variant resolves to a definitely missing model, it is skipped for that run and a warning toast is shown.
- Conflicting aliases are skipped instead of overwriting existing agents.

Use the wizard's `Run diagnostics` action to inspect model validation, alias conflicts, disabled parents, and plugin installation state.

## Debug Mode

Debug mode is off by default. Enable it from the wizard with `Debug mode: off`.

When enabled, the server plugin emits diagnostic log lines and TUI toast notifications for built-in virtual variants:

- when a variant is routed, such as `general-light -> general`
- the short internal route token used for correlation
- the target model and model variant
- when the model override is applied to the child session message

Logs are written to `~/.config/opencode/agent-variants.debug.log`. The plugin does not write debug lines to stdout, because that can corrupt the terminal UI.

Debug mode is stored in `agent-variants.jsonc` and takes effect immediately for future variant calls. The wizard can also view and clear the debug log.

## Development

Install dependencies:

```sh
npm install
```

Typecheck:

```sh
npm run typecheck
```

Build:

```sh
npm run build
```

Check package contents before publishing:

```sh
npm pack --dry-run
```

## License

MIT
