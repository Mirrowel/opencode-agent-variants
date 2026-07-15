import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildSolidTui } from "./solid-tui-build.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const output = path.join(root, "dist", "tui.js")
await buildSolidTui(path.join(root, "src", "tui.tsx"), path.join(root, "dist"))
if (!existsSync(output)) throw new Error("Reactive TUI build did not produce dist/tui.js")

console.log("reactive TUI build passed")
