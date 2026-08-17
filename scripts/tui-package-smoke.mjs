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
  const packs = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp]))
  const packed = Array.isArray(packs) ? packs[0] : Object.values(packs)[0]
  if (!packed?.filename) throw new Error("npm pack returned an unsupported JSON result")
  const tarball = path.join(temp, packed.filename)
  writeFileSync(
    path.join(temp, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: { [pkg.name]: `file:${tarball}` } }, null, 2)}\n`,
  )
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temp })

  const installedRoot = path.join(temp, "node_modules", ...pkg.name.split("/"))
  const installedPackage = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"))
  if (installedPackage.exports?.["./tui"]?.import !== "./dist/tui.js") {
    throw new Error("packed TUI export does not target the compiled artifact")
  }
  if (installedPackage.exports?.["./wizard"]?.import !== "./dist/wizard.js") {
    throw new Error("packed wizard export does not target the compiled artifact")
  }
  const artifact = readFileSync(path.join(installedRoot, "dist", "tui.js"), "utf8")
  if (artifact.includes("@opentui/solid/jsx-runtime")) {
    throw new Error("packed TUI uses non-reactive automatic JSX runtime")
  }
  if (!artifact.includes("effect") || !artifact.includes("setProp")) {
    throw new Error("packed TUI is missing Solid reactive property effects")
  }
  const wizardArtifact = readFileSync(path.join(installedRoot, "dist", "wizard.js"), "utf8")
  if (wizardArtifact.includes("@opentui/solid/jsx-runtime")) {
    throw new Error("packed wizard uses non-reactive automatic JSX runtime")
  }
  if (!wizardArtifact.includes("effect") || !wizardArtifact.includes("setProp")) {
    throw new Error("packed wizard is missing Solid reactive property effects")
  }

  const check = [
    'import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"',
    "ensureRuntimePluginSupport()",
    `const mod = await import(${JSON.stringify(`${pkg.name}/tui`)})`,
    'if (mod.default?.id !== "agent-variants" || typeof mod.default?.tui !== "function") throw new Error("invalid TUI plugin export")',
    `const wizard = await import(${JSON.stringify(`${pkg.name}/wizard`)})`,
    'if (typeof wizard.mainMenu !== "function" || typeof wizard.newWizardSettings !== "function" || typeof wizard.addVariantFor !== "function" || typeof wizard.editVariantFor !== "function" || typeof wizard.toggleEntryFor !== "function" || typeof wizard.deleteVariantFor !== "function" || typeof wizard.editParentFields !== "function" || typeof wizard.manageModelPresets !== "function" || typeof wizard.pickParentAgent !== "function" || typeof wizard.wizardInfoText !== "function" || typeof wizard.applyWizardUiSettings !== "function" || typeof wizard.variantCount !== "function" || typeof wizard.generatedAliasSet !== "function" || typeof wizard.agentModes !== "function") throw new Error("wizard library is missing embedded-host exports")',
    `const config = await import(${JSON.stringify(`${pkg.name}/config`)})`,
    'if (typeof config.loadSidecar !== "function" || typeof config.diagnoseConfig !== "function" || typeof config.saveSidecar !== "function") throw new Error("config export is missing expected functions")',
    'console.log("packed TUI import passed")',
  ].join("; ")
  run("bun", ["--conditions=browser", "-e", check], { cwd: temp })
  console.log("packed TUI smoke test passed")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
