import { existsSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
})

if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout)
  process.exit(result.status ?? 1)
}

const packs = JSON.parse(result.stdout)
const pack = packs[0]
const files = new Set(pack.files.map((file) => file.path))
const required = [
  "dist/server.js",
  "dist/index.js",
  "dist/config.js",
  "src/tui.tsx",
  "src/config.ts",
  "src/index.ts",
  "src/server.ts",
  "tsconfig.json",
  "docs/CONFIG.md",
]

const missing = required.filter((file) => !files.has(file))
if (missing.length > 0) {
  throw new Error(`Package dry-run is missing required file(s): ${missing.join(", ")}`)
}

if (pack.filename && existsSync(pack.filename)) {
  unlinkSync(pack.filename)
}

console.log(`package dry-run passed (${pack.files.length} files, ${pack.filename})`)
