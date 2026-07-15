import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { buildSolidTui } from "./solid-tui-build.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const temp = mkdtempSync(path.join(root, "scripts", ".tui-reactivity-"))

try {
  await buildSolidTui(path.join(root, "scripts", "fixtures", "tui-reactivity.tsx"), temp)
  const output = path.join(temp, "tui-reactivity.js")
  const code = readFileSync(output, "utf8")
  if (code.includes("@opentui/solid/jsx-runtime")) {
    throw new Error("reactivity fixture used non-reactive automatic JSX runtime")
  }
  if (!code.includes("effect") || !code.includes("setProp")) {
    throw new Error("reactivity fixture is missing Solid reactive property effects")
  }
  const fixture = await import(`${pathToFileURL(output).href}?${Date.now()}`)
  await fixture.verifyReactiveSelection()
  console.log("TUI selection repaint test passed")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
