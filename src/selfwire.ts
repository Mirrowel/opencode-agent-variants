/**
 * Self-wiring for the agent-variants TUI (v1 hosts only).
 *
 * OpenCode loads server plugins from the `plugin` array in opencode.json
 * layers but TUI plugins only from tui.json layers. When agent-variants is
 * registered standalone (opencode.json) without a matching tui.json entry,
 * the wizard command never loads. ensureTuiRegistration() mirrors the server
 * registration into the tui.json AT THE SAME CONFIG LEVEL (global -> global,
 * project -> project) with the same auto-correct semantics as Config
 * Studio's selfwire:
 *
 * - identity matching: any checkout counts (repo folder named plain
 *   `agent-variants` or `opencode-agent-variants`), not just this running
 *   instance's directory
 * - the tui entry must MATCH the server registration; local checkouts win
 *   over npm installs when both are registered
 * - stale mirrors (tui entries at levels without a server registration) are
 *   removed; duplicates are deduped
 *
 * When Config Studio is registered anywhere (it embeds agent-variants and
 * provides the wizard UI), selfwiring is skipped entirely so the two never
 * fight over the TUI slot. v2 hosts never run this module: they
 * auto-discover ./tui from server-declared plugins, and the v2 setup does
 * not import it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, stringify } from "comment-json"

const AV_NPM = "@mirrowel/opencode-agent-variants"
const STUDIO_NPM = "@mirrowel/opencode-config-studio"

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function specPathSegments(spec: string): string | undefined {
  if (!spec.startsWith("file:")) return undefined
  try {
    let url = spec
    if (!url.startsWith("file:///") && url.startsWith("file://")) url = `file:///${url.slice("file://".length)}`
    return normalizePath(new URL(url).pathname)
  } catch {
    return undefined
  }
}

function isLocalSpec(spec: string): boolean {
  return spec.startsWith("file:") || /^([a-zA-Z]:[\\/]|\/)/.test(spec)
}

export function isAgentVariantsSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === AV_NPM || spec.startsWith(`${AV_NPM}@`)) return true
  const path = specPathSegments(spec)
  if (!path) return false
  if (path.endsWith("/opencode-agent-variants") || path.endsWith("/agent-variants")) return true
  // Cache/wrapper layouts: <base>/@mirrowel/opencode-agent-variants@<tag>[/node_modules/...]
  return path.includes("/@mirrowel/opencode-agent-variants") || path.includes("/node_modules/@mirrowel/opencode-agent-variants")
}

export function isConfigStudioSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === STUDIO_NPM || spec.startsWith(`${STUDIO_NPM}@`)) return true
  const path = specPathSegments(spec)
  if (!path) return false
  return path.endsWith("/opencode-config-studio")
}

function specStrings(data: Record<string, unknown>): string[] {
  const result: string[] = []
  for (const key of ["plugin", "plugins"] as const) {
    const array = data[key]
    if (!Array.isArray(array)) continue
    for (const entry of array) {
      const spec =
        typeof entry === "string"
          ? entry
          : Array.isArray(entry) && typeof entry[0] === "string"
            ? (entry[0] as string)
            : entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string"
              ? (entry as { package: string }).package
              : undefined
      if (spec !== undefined) result.push(spec)
    }
  }
  return result
}

function readJsonc(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    return parse(readFileSync(path, "utf8")) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

function sameDir(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

function levelDirOf(configPath: string): string {
  let dir = dirname(configPath)
  if (basename(dir) === ".opencode") dir = dirname(dir)
  return dir
}

function globalConfigDir(env?: NodeJS.ProcessEnv): string {
  if (env?.["OPENCODE_CONFIG_DIR"]) return env["OPENCODE_CONFIG_DIR"]
  if (env?.["XDG_CONFIG_HOME"]) return join(env["XDG_CONFIG_HOME"], "opencode")
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  return join(home, ".config", "opencode")
}

function opencodeLayerPaths(input: { directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): string[] {
  const paths: string[] = []
  const pushDir = (dir: string) => {
    for (const candidate of [join(dir, "opencode.json"), join(dir, "opencode.jsonc"), join(dir, ".opencode", "opencode.json"), join(dir, ".opencode", "opencode.jsonc")]) {
      if (existsSync(candidate) && !paths.includes(candidate)) paths.push(candidate)
    }
  }
  const globalDir = globalConfigDir(input.env)
  if (input.env?.["OPENCODE_CONFIG"]) {
    if (existsSync(input.env["OPENCODE_CONFIG"])) paths.push(input.env["OPENCODE_CONFIG"])
  } else {
    pushDir(globalDir)
  }
  if (input.directory && input.worktree && input.directory.startsWith(input.worktree)) {
    let current: string | undefined = input.directory
    for (let guard = 0; guard < 64 && current; guard++) {
      pushDir(current)
      if (current === input.worktree || current === dirname(current)) break
      current = dirname(current)
    }
  }
  return paths
}

function tuiLayerPaths(input: { directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): string[] {
  const paths: string[] = []
  const globalDir = globalConfigDir(input.env)
  const globalTui = join(globalDir, "tui.json")
  if (existsSync(globalTui)) paths.push(globalTui)
  const envTui = input.env?.["OPENCODE_TUI_CONFIG"]
  if (envTui && existsSync(envTui)) paths.push(envTui)
  if (input.directory && input.worktree && input.directory.startsWith(input.worktree)) {
    let current: string | undefined = input.directory
    for (let guard = 0; guard < 64 && current; guard++) {
      for (const candidate of [join(current, "tui.json"), join(current, ".opencode", "tui.json")]) {
        if (existsSync(candidate) && !paths.includes(candidate)) paths.push(candidate)
      }
      if (current === input.worktree || current === dirname(current)) break
      current = dirname(current)
    }
  }
  return paths
}

function ownIndices(tuiPath: string): number[] {
  const data = readJsonc(tuiPath)
  const plugin = data["plugin"]
  if (!Array.isArray(plugin)) return []
  const indices: number[] = []
  plugin.forEach((entry, index) => {
    const spec = typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? (entry[0] as string) : undefined
    if (spec !== undefined && isAgentVariantsSpec(spec)) indices.push(index)
  })
  return indices
}

function preferLocal(specs: string[]): string[] {
  const local = specs.filter(isLocalSpec)
  const npm = specs.filter((spec) => !local.includes(spec))
  return [...local, ...npm]
}

function atomicWrite(path: string, content: string, stateDir: string): boolean {
  try {
    const backupDir = join(stateDir, "selfwire-backups")
    mkdirSync(backupDir, { recursive: true })
    if (existsSync(path)) {
      const backup = join(backupDir, `${basename(path)}.${Date.now()}.bak`)
      writeFileSync(backup, readFileSync(path, "utf8"), "utf8")
    }
    const temp = `${path}.av-tmp`
    writeFileSync(temp, content, "utf8")
    renameSync(temp, path)
    return true
  } catch {
    return false
  }
}

export type WireResult =
  | { status: "skipped-studio" }
  | { status: "already-wired"; spec: string }
  | { status: "wired"; spec: string; target: string }
  | { status: "corrected"; spec: string; target: string }
  | { status: "not-registered" }
  | { status: "failed"; error: string }

/**
 * Mirrors the standalone agent-variants server registration into tui.json
 * (same config level). No-op when Config Studio is registered anywhere - it
 * embeds agent-variants and provides the wizard UI itself.
 */
export function ensureTuiRegistration(input: { directory?: string; worktree?: string; env?: NodeJS.ProcessEnv } = {}): WireResult {
  try {
    const opencodeLayers = opencodeLayerPaths(input)
    const tuiLayers = tuiLayerPaths(input)

    // Config Studio present anywhere (server or tui layers) -> stand down.
    for (const layer of [...opencodeLayers, ...tuiLayers]) {
      if (specStrings(readJsonc(layer)).some((spec) => isConfigStudioSpec(spec))) {
        return { status: "skipped-studio" }
      }
    }

    const registrations = opencodeLayers
      .map((path) => ({
        path,
        level: levelDirOf(path),
        specs: specStrings(readJsonc(path)).filter((spec) => isAgentVariantsSpec(spec)),
      }))
      .filter((layer) => layer.specs.length > 0)
    if (registrations.length === 0) return { status: "not-registered" }

    const preferAt = (layers: typeof registrations): string | undefined => {
      const ordered = [...layers].sort((a, b) => {
        const aLocal = a.specs.some(isLocalSpec)
        const bLocal = b.specs.some(isLocalSpec)
        if (aLocal !== bLocal) return aLocal ? -1 : 1
        return 0
      })
      const first = ordered[0]
      return first ? preferLocal(first.specs)[0] : undefined
    }
    const wanted = preferAt(registrations)
    if (!wanted) return { status: "not-registered" }
    const wantedLevel = registrations.find((layer) => layer.specs.includes(wanted))?.level ?? globalConfigDir(input.env)
    const target = sameDir(wantedLevel, globalConfigDir(input.env))
      ? join(globalConfigDir(input.env), "tui.json")
      : join(wantedLevel, "tui.json")

    const stateDir = join(globalConfigDir(input.env), "agent-variants")
    let wired = false
    let corrected = false

    const seen = new Set<string>()
    const fixTuiFile = (tuiPath: string, level: string) => {
      if (seen.has(tuiPath)) return
      seen.add(tuiPath)
      const indices = ownIndices(tuiPath)
      if (indices.length === 0) return
      const levelLayers = registrations.filter((layer) => sameDir(layer.level, level))
      const data = readJsonc(tuiPath)
      const plugin = data["plugin"]
      if (!Array.isArray(plugin)) return
      if (levelLayers.length === 0) {
        // Stale mirror: no server registration at this level.
        for (const index of [...indices].sort((a, b) => b - a)) plugin.splice(index, 1)
        corrected = true
      } else {
        const wantedHere = preferAt(levelLayers) ?? wanted
        const keepIndex = indices[0]!
        let changed = false
        if (indices.length > 1) {
          for (const index of [...indices].slice(1).sort((a, b) => b - a)) plugin.splice(index, 1)
          changed = true
        }
        const entry = plugin[keepIndex]
        const spec = typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? (entry[0] as string) : undefined
        if (spec !== wantedHere) {
          if (Array.isArray(entry)) entry[0] = wantedHere
          else plugin[keepIndex] = wantedHere
          changed = true
        }
        if (changed) corrected = true
        else return
      }
      if (!atomicWrite(tuiPath, stringify(data, null, 2) + "\n", stateDir)) {
        throw new Error(`failed to write ${tuiPath}`)
      }
    }

    for (const layer of tuiLayers) fixTuiFile(layer, levelDirOf(layer))

    // Ensure the registration level carries its mirror (independent of the
    // correction pass above - an empty plugin array still needs the entry).
    const targetIndices = existsSync(target) ? ownIndices(target) : []
    if (targetIndices.length === 0) {
      const data = readJsonc(target)
      const plugin = Array.isArray(data["plugin"]) ? (data["plugin"] as unknown[]) : []
      plugin.push(wanted)
      data["plugin"] = plugin
      if (!atomicWrite(target, stringify(data, null, 2) + "\n", stateDir)) {
        return { status: "failed", error: `failed to write ${target}` }
      }
      wired = true
    }

    if (wired) return { status: "wired", spec: wanted, target }
    if (corrected) return { status: "corrected", spec: wanted, target }
    return { status: "already-wired", spec: wanted }
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}
