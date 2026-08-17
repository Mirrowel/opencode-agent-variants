/** @jsxImportSource @opentui/solid */

/**
 * Agent Variants TUI plugin entry.
 *
 * Thin wrapper: registers the palette/slash command and bootstraps the wizard
 * library (wizard.tsx) with standalone behavior — Save & exit writes the
 * sidecar immediately. Config Studio imports the wizard library directly and
 * stages saves into its unified change queue instead.
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { defaultSidecarPath, loadSidecar } from "./config.js"
import { applyWizardUiSettings, mainMenu, newWizardSettings } from "./wizard.js"

function registerConfigureCommand(api: import("@opencode-ai/plugin/tui").TuiPluginApi, run: () => Promise<void>) {
  const command = {
    namespace: "palette",
    name: "agent-variants.configure",
    title: "Agent Variants: Configure",
    desc: "Manage agent model variants",
    category: "Plugins",
    slashName: "agent-variants",
    run,
  }
  const apiWithKeymap = api as import("@opencode-ai/plugin/tui").TuiPluginApi & {
    keymap?: {
      registerLayer?: (layer: { commands: Array<typeof command>; bindings: unknown[] }) => () => void
    }
  }
  if (typeof apiWithKeymap.keymap?.registerLayer === "function") {
    return apiWithKeymap.keymap.registerLayer({ commands: [command], bindings: [] })
  }
  return api.command?.register(() => [
    {
      title: "Agent Variants: Configure",
      value: "agent-variants.configure",
      description: "Manage agent model variants",
      category: "Plugins",
      slash: {
        name: "agent-variants",
      },
      onSelect: run,
    },
  ])
}

const tui: TuiPlugin = async (api) => {
  const unregister = registerConfigureCommand(api, async () => {
    const config = loadSidecar(defaultSidecarPath())
    applyWizardUiSettings(api, config)
    await mainMenu(api, config, newWizardSettings(true))
  })

  api.lifecycle.onDispose(() => {
    unregister?.()
  })
}

export default { id: "agent-variants", tui }
