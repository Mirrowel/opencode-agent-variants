#!/usr/bin/env node
// Generates schema.json for agent-variants.jsonc from the Zod SidecarConfig
// schema, so editors can validate the sidecar via
// "$schema": "https://unpkg.com/@mirrowel/opencode-agent-variants/schema.json".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dist = join(root, "dist", "config.js")

const mod = await import(`file://${dist.replace(/\\/g, "/")}?${Date.now()}`)
const { SidecarConfig } = mod
if (!SidecarConfig || typeof SidecarConfig.toJSONSchema !== "function") {
  console.error("SidecarConfig schema not found in dist/config.js (zod v4 required)")
  process.exit(1)
}

const json = SidecarConfig.toJSONSchema({
  io: "input",
  target: "draft-2020-12",
  reused: "inline",
})
json.$schema = "https://json-schema.org/draft/2020-12/schema"
json.title = json.title ?? "OpenCode Agent Variants sidecar config"
json.description = json.description ?? "Configuration for @mirrowel/opencode-agent-variants (agent-variants.jsonc)."

const out = join(root, "schema.json")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`, "utf8")
const bytes = readFileSync(out).length
console.log(`schema.json generated (${(bytes / 1024).toFixed(1)} KB)`)
