import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildSolidTui } from "./solid-tui-build.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))

// Every TUI entry gets its own Solid-compiled bundle: the plugin entry (tui.tsx)
// and the embeddable wizard library (wizard.tsx, consumed by Config Studio).
const entries = ["tui.tsx", "wizard.tsx"]
for (const entry of entries) {
  const source = path.join(root, "src", entry)
  const output = path.join(root, "dist", entry.replace(/\.tsx$/, ".js"))
  await buildSolidTui(source, path.join(root, "dist"))
  if (!existsSync(output)) throw new Error(`Reactive TUI build did not produce dist/${entry.replace(/\.tsx$/, ".js")}`)
}

console.log("reactive TUI build passed")
