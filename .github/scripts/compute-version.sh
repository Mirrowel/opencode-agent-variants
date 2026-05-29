#!/usr/bin/env bash
set -euo pipefail

# TODO(definitive-release-workflow): Keep this script structurally aligned with
# LLM-API-Key-Proxy's release workflow. If the same behavior is needed in more
# repos, extract this Bash/YAML pattern into a small shared action or reusable
# workflow rather than letting copies drift.

semver_sort() {
  sort -V
}

semver_max() {
  printf '%s\n' "$@" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | semver_sort | tail -n 1
}

bump_version() {
  local version="$1"
  local bump="$2"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$version"
  case "$bump" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    none) echo "$major.$minor.$patch" ;;
    *) echo "Unsupported bump: $bump" >&2; exit 1 ;;
  esac
}

latest_stable_tag() {
  git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | semver_sort | tail -n 1 || true
}

latest_channel_tag() {
  local channel="$1"
  git tag --merged HEAD --list "v[0-9]*.[0-9]*.[0-9]*-$channel.*" | semver_sort | tail -n 1 || true
}

latest_prerelease_base() {
  git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*-*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-(dev|alpha|beta|rc|canary)\.[0-9]+$' \
    | sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/' \
    | semver_sort \
    | tail -n 1 || true
}

conventional_bump_since() {
  local tag="$1"
  local range="HEAD"
  if [ -n "$tag" ]; then
    range="$tag..HEAD"
  fi
  local log
  log="$(git log "$range" --format='%s%n%b%n---END---' 2>/dev/null || true)"
  if printf '%s\n' "$log" | grep -Eq 'BREAKING CHANGE:|^[a-zA-Z]+(\([^)]*\))?!:'; then
    echo major
    return
  fi
  if printf '%s\n' "$log" | grep -Eq '^feat(\([^)]*\))?:'; then
    echo minor
    return
  fi
  if printf '%s\n' "$log" | grep -Eq '^(fix|perf)(\([^)]*\))?:'; then
    echo patch
    return
  fi
  echo none
}

next_prerelease_number() {
  local package_name="$1"
  local base_version="$2"
  local channel="$3"
  npm view "$package_name" versions --json 2>/dev/null | node -e '
    const fs = require("node:fs")
    const versions = JSON.parse(fs.readFileSync(0, "utf8") || "[]")
    const base = process.argv[1]
    const channel = process.argv[2]
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`^${escaped}-${channel}\\.(\\d+)$`)
    const latest = versions
      .map((version) => re.exec(version)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .at(-1)
    console.log((latest ?? 0) + 1)
  ' "$base_version" "$channel"
}

validate_stable_version() {
  local version="$1"
  if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "Expected a stable semver version, got: $version" >&2
    exit 1
  fi
}

package_name="$(node -p "require('./package.json').name")"
intent_version="$(node -p "require('./.release.json').next")"
validate_stable_version "$intent_version"

branch="${RELEASE_BRANCH:-main}"
channel="${RELEASE_CHANNEL:-}"
if [ -z "$channel" ]; then
  if [ "$branch" = "main" ]; then
    channel="latest"
  else
    channel="$branch"
  fi
fi

case "$channel" in
  latest|dev|alpha|beta|rc|canary) ;;
  *) echo "Unsupported release channel: $channel" >&2; exit 1 ;;
esac

target_version="${TARGET_VERSION:-}"
if [ -n "$target_version" ]; then
  validate_stable_version "$target_version"
fi

version_bump="${VERSION_BUMP:-auto}"
case "$version_bump" in
  auto|none|patch|minor|major) ;;
  *) echo "Unsupported version bump: $version_bump" >&2; exit 1 ;;
esac

stable_tag="$(latest_stable_tag)"
prerelease_line="$(latest_prerelease_base)"
stable_version="0.0.0"
if [ -n "$stable_tag" ]; then
  stable_version="${stable_tag#v}"
fi

if [ "$version_bump" = "auto" ]; then
  bump="$(conventional_bump_since "$stable_tag")"
else
  bump="$version_bump"
fi

# Stable releases promote the highest prerelease base. If dev published
# 0.5.0-dev.N, merging dev to main must release at least 0.5.0 even if the
# merge commit range would otherwise infer a smaller conventional-commit bump.
stable_candidate="$(semver_max "$intent_version" "$prerelease_line" "$(bump_version "$stable_version" "$bump")")"
prerelease_default_bump="minor"
if [ "$bump" = "major" ]; then
  prerelease_default_bump="major"
fi
prerelease_base="$(semver_max "$intent_version" "$prerelease_line" "$(bump_version "$stable_version" "$prerelease_default_bump")")"

force_release="${FORCE_RELEASE:-false}"
if [ -n "$target_version" ]; then
  stable_candidate="$target_version"
  prerelease_base="$target_version"
fi

prerelease="false"
latest="true"
npm_tag="$channel"
base_version="$stable_candidate"
should_release="false"

if [ "$channel" != "latest" ]; then
  prerelease="true"
  latest="false"
  base_version="$prerelease_base"
  prerelease_number="$(next_prerelease_number "$package_name" "$base_version" "$channel")"
  version="$base_version-$channel.$prerelease_number"
  tag="v$version"
  previous_tag="$(latest_channel_tag "$channel")"
  if [ -z "$previous_tag" ]; then
    previous_tag="$stable_tag"
  fi
  should_release="true"
else
  version="$stable_candidate"
  tag="v$version"
  previous_tag="$stable_tag"
  if [ "$force_release" = "true" ] || [ -n "$target_version" ] || [ "$(printf '%s\n%s\n' "$stable_version" "$stable_candidate" | semver_sort | tail -n 1)" != "$stable_version" ]; then
    should_release="true"
  fi
fi

{
  echo "branch=$branch"
  echo "channel=$channel"
  echo "npm_tag=$npm_tag"
  echo "version=$version"
  echo "base_version=$base_version"
  echo "tag=$tag"
  echo "previous_tag=$previous_tag"
  echo "prerelease_line=$prerelease_line"
  echo "prerelease=$prerelease"
  echo "latest=$latest"
  echo "should_release=$should_release"
  echo "bump=$bump"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"
