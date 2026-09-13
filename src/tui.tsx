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
import { createV2TuiSetup } from "./v2-tui.js"
import { applyWizardUiSettings, mainMenu, newWizardSettings } from "./wizard.js"
import { currentPaletteCategory, declarePaletteCategory, schedulePaletteReconcile } from "./palette-category.js"

function registerConfigureCommand(api: import("@opencode-ai/plugin/tui").TuiPluginApi, run: () => Promise<void>) {
  const command = {
    namespace: "palette",
    name: "agent-variants.configure",
    title: "Agent Variants: Configure",
    desc: "Manage agent model variants",
    category: "",
    slashName: "agent-variants",
    run,
  }
  command.category = declarePaletteCategory("Agent Variants", command)
  schedulePaletteReconcile()
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
      category: currentPaletteCategory(),
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

/**
 * Dual-target TUI entry.
 *
 * - OpenCode v1 (strict loader) requires `default.tui` to be a function;
 *   excess keys are ignored.
 * - OpenCode v2 requires `default` to be `{ id, setup }`; its hand-written
 *   plugin check only inspects `id` + `setup`, so the legacy `tui` factory
 *   rides along harmlessly.
 */
export default { id: "agent-variants", tui, setup: createV2TuiSetup() }
