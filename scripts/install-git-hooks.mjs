#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

const source = join(".githooks", "pre-commit")
const target = join(".git", "hooks", "pre-commit")

if (!existsSync(".git")) {
  console.error("No .git directory found. Run this from the repository root.")
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
chmodSync(target, 0o755)
console.log(`Installed ${target}`)
