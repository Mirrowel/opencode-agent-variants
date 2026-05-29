#!/usr/bin/env node
import { appendFileSync } from "node:fs"
import {
  bumpVersion,
  compareVersions,
  conventionalBumpSince,
  isStableVersion,
  latestChannelTag,
  latestStableTag,
  maxVersion,
  nextPrereleaseNumber,
  parseVersion,
  readJson,
  updatePackageVersion,
} from "./release-lib.mjs"

const pkg = readJson("package.json")
const intent = readJson(".release.json")
const branch = process.env.RELEASE_BRANCH || "main"
const manualChannel = process.env.RELEASE_CHANNEL || ""
const channel = manualChannel || (branch === "main" ? "latest" : branch)
const targetVersion = process.env.TARGET_VERSION || ""
const forcedBump = process.env.VERSION_BUMP || "auto"
const forceRelease = process.env.FORCE_RELEASE === "true"
const applyVersion = process.env.APPLY_VERSION !== "false"
const output = process.env.GITHUB_OUTPUT

if (!["latest", "dev", "alpha", "beta", "rc", "canary"].includes(channel)) {
  throw new Error(`Unsupported release channel: ${channel}`)
}

if (targetVersion) {
  parseVersion(targetVersion)
  if (!isStableVersion(targetVersion)) throw new Error("target_version must be a stable version without prerelease suffix.")
}

const stableTag = latestStableTag()
const stableVersion = stableTag?.slice(1) ?? "0.0.0"
const bump = forcedBump === "auto" ? conventionalBumpSince(stableTag) : forcedBump
if (!["auto", "none", "patch", "minor", "major"].includes(forcedBump)) throw new Error(`Unsupported version_bump: ${forcedBump}`)

const intentVersion = intent.next
parseVersion(intentVersion)

const stableCandidate = targetVersion || maxVersion(intentVersion, bumpVersion(stableVersion, bump))
const prereleaseDefaultBump = bump === "major" ? "major" : "minor"
const prereleaseBase = targetVersion || maxVersion(intentVersion, bumpVersion(stableVersion, prereleaseDefaultBump))
const shouldReleaseStable = forceRelease || Boolean(targetVersion) || compareVersions(stableCandidate, stableVersion) > 0

const isPrerelease = channel !== "latest"
const baseVersion = isPrerelease ? prereleaseBase : stableCandidate
const prereleaseNumber = isPrerelease ? nextPrereleaseNumber(pkg.name, baseVersion, channel) : undefined
const version = isPrerelease ? `${baseVersion}-${channel}.${prereleaseNumber}` : baseVersion
const tag = isPrerelease ? `${channel}/v${version}` : `v${version}`
const previousTag = isPrerelease ? latestChannelTag(channel) || stableTag || "" : stableTag || ""
const shouldRelease = isPrerelease ? true : shouldReleaseStable

if (shouldRelease && applyVersion) updatePackageVersion(version)

const values = {
  branch,
  channel,
  npm_tag: channel,
  version,
  base_version: baseVersion,
  tag,
  previous_tag: previousTag,
  prerelease: String(isPrerelease),
  latest: String(!isPrerelease),
  should_release: String(shouldRelease),
  bump,
}

for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`)
if (output) appendFileSync(output, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`)
