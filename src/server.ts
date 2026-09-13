import plugin from "./index.js"
import { createV2ServerSetup } from "./v2-server.js"

/**
 * Dual-target server entry.
 *
 * - OpenCode v1 resolves `exports["./server"]`, reads `mod.default`, and
 *   invokes the `server` factory (excess keys are never validated).
 * - OpenCode v2 imports the same module, validates `mod.default` as
 *   `{ id, setup }`, and ignores the legacy `server` key — so one default
 *   export satisfies both loaders.
 */
export default {
  id: "agent-variants",
  server: plugin,
  setup: createV2ServerSetup(),
}
