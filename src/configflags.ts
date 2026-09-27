/**
 * Surgical editor for OpenCode agent visibility flags in the GLOBAL config
 * (`agent.<name>.hidden` / `agent.<name>.disable`). The unified parent-mode
 * picker writes both flags here - OpenCode-native flags belong in
 * opencode.json, not the sidecar. Comment-preserving via comment-json (same
 * library the self-wire uses), one rolling backup per file, atomic rename.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { parse, stringify } from "comment-json"
import { defaultConfigDir } from "./config.js"

/** Global config candidates, most-preferred write target first. */
function globalConfigCandidates(configDir = defaultConfigDir()): string[] {
  return [join(configDir, "opencode.jsonc"), join(configDir, "opencode.json"), join(configDir, "config.json")]
}

/** The file flag edits go to: the first existing candidate, else opencode.json (created). */
export function globalConfigWriteTarget(configDir = defaultConfigDir()): string {
  for (const candidate of globalConfigCandidates(configDir)) {
    if (existsSync(candidate)) return candidate
  }
  return join(configDir, "opencode.json")
}

export type AgentConfigFlags = { hidden?: boolean; disable?: boolean }

/** Reads the current visibility flags of one agent from the global config. */
export function readAgentFlags(agent: string, configDir = defaultConfigDir()): AgentConfigFlags {
  for (const candidate of globalConfigCandidates(configDir)) {
    if (!existsSync(candidate)) continue
    try {
      const data = parse(readFileSync(candidate, "utf8")) as Record<string, any>
      const entry = data?.agent?.[agent]
      if (!entry || typeof entry !== "object") return {}
      return {
        hidden: entry.hidden === true,
        disable: entry.disable === true,
      }
    } catch {
      continue
    }
  }
  return {}
}

function writeAgentFlag(target: string, agent: string, key: "hidden" | "disable", set: boolean): string | undefined {
  let data: Record<string, any>
  try {
    data = parse(readFileSync(target, "utf8")) as Record<string, any>
  } catch (error) {
    return `could not parse ${basename(target)}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!data.agent || typeof data.agent !== "object") {
    if (!set) return undefined
    data.agent = {}
  }
  const entry = data.agent[agent]
  if (!entry || typeof entry !== "object") {
    if (!set) return undefined
    data.agent[agent] = { [key]: true }
  } else if (set) {
    entry[key] = true
  } else {
    delete entry[key]
    if (Object.keys(entry).length === 0) delete data.agent[agent]
    if (Object.keys(data.agent).length === 0) delete data.agent
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      const backup = `${target}.av-flag-backup`
      writeFileSync(backup, readFileSync(target, "utf8"), "utf8")
    }
    const temp = `${target}.av-tmp`
    writeFileSync(temp, stringify(data, null, 2), "utf8")
    renameSync(temp, target)
    return undefined
  } catch (error) {
    return `write failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Writes one agent's visibility flags to the global config.
 * `true` sets the key, `false` deletes it, `undefined` leaves it unchanged.
 * Returns an error string on failure, undefined on success. */
export function writeAgentFlags(agent: string, flags: AgentConfigFlags, configDir = defaultConfigDir()): string | undefined {
  const target = globalConfigWriteTarget(configDir)
  if (flags.hidden !== undefined) {
    const error = writeAgentFlag(target, agent, "hidden", flags.hidden)
    if (error) return error
  }
  if (flags.disable !== undefined) {
    const error = writeAgentFlag(target, agent, "disable", flags.disable)
    if (error) return error
  }
  return undefined
}
