import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const temp = mkdtempSync(path.join(tmpdir(), "agent-variants-tui-"))

function run(command, args, options = {}) {
  const npmCli = command === "npm" ? process.env.npm_execpath : undefined
  const executable = npmCli ? process.execPath : command
  const commandArgs = npmCli ? [npmCli, ...args] : args
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: false,
    env: process.env,
  })
  if (result.status === 0) return result.stdout
  if (result.error) console.error(result.error)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`)
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp]))[0]
  const tarball = path.join(temp, packed.filename)
  writeFileSync(
    path.join(temp, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: { [pkg.name]: `file:${tarball}` } }, null, 2)}\n`,
  )
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temp })

  const check = [
    'import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"',
    "ensureRuntimePluginSupport()",
    `const mod = await import(${JSON.stringify(`${pkg.name}/tui`)})`,
    'if (mod.default?.id !== "agent-variants" || typeof mod.default?.tui !== "function") throw new Error("invalid TUI plugin export")',
    'console.log("packed TUI import passed")',
  ].join("; ")
  run("bun", ["--conditions=browser", "-e", check], { cwd: temp })
  console.log("packed TUI smoke test passed")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
