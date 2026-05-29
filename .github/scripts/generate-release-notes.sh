#!/usr/bin/env bash
set -euo pipefail

# TODO(definitive-release-workflow): Keep the final release-note shape shared
# with LLM-API-Key-Proxy: package/build metadata, install instructions, grouped
# changelog, community contributors, useful links, and prerelease warnings.

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
previous_tag="${PREVIOUS_TAG:-}"
channel="${RELEASE_CHANNEL:?RELEASE_CHANNEL is required}"
npm_tag="${NPM_TAG:?NPM_TAG is required}"
prerelease="${PRERELEASE:-false}"
commit_sha="${GITHUB_SHA:?GITHUB_SHA is required}"

range="HEAD"
if [ -n "$previous_tag" ]; then
  range="$previous_tag..HEAD"
fi

generate_changelog() {
  if [ -n "$previous_tag" ]; then
    git-cliff --config .github/cliff.toml --github-repo "$repo" --strip all --output changes.md "$range"
    return
  fi
  cat > changes.md <<'EOF'
## Initial Release

This is the first release for this channel.
EOF
}

normalize_changelog() {
  # Stable releases compare from the latest stable tag, so prerelease tags can
  # appear inside the range. Keep their commits, but remove the prerelease
  # subheadings so the stable release notes read as one coherent release.
  sed -i -E '/^## Changes in v[0-9]+\.[0-9]+\.[0-9]+-(dev|alpha|beta|rc|canary)\.[0-9]+$/d' changes.md
}

resolve_author_placeholders() {
  if ! grep -qE '\[\[[a-f0-9]{40}\|' changes.md 2>/dev/null; then
    return
  fi

  if [ -n "$previous_tag" ]; then
    author_map="$(gh api "repos/$repo/compare/$previous_tag...$commit_sha" --jq '[.commits[] | {sha: .sha, username: .author.login}] | map(select(.username != null))' 2>/dev/null || echo '[]')"
    while read -r entry; do
      [ -z "$entry" ] && continue
      sha="$(printf '%s' "$entry" | jq -r '.sha')"
      username="$(printf '%s' "$entry" | jq -r '.username')"
      [ -z "$sha" ] || [ -z "$username" ] || [ "$username" = "null" ] && continue
      sed -i "s|\[\[$sha[^]]*\]\]|@$username|g" changes.md
    done < <(printf '%s' "$author_map" | jq -c '.[]' 2>/dev/null || true)
  fi

  remaining="$(grep -oE '\[\[[a-f0-9]{40}\|[^]]*\]\]' changes.md 2>/dev/null || true)"
  while read -r placeholder; do
    [ -z "$placeholder" ] && continue
    sha="$(printf '%s' "$placeholder" | sed 's/\[\[\([^|]*\)|.*/\1/')"
    username="$(gh api "repos/$repo/commits/$sha" --jq '.author.login // empty' 2>/dev/null || true)"
    if [ -n "$username" ]; then
      sed -i "s|\[\[$sha[^]]*\]\]|@$username|g" changes.md
    fi
  done <<< "$remaining"

  remaining="$(grep -oE '\[\[[a-f0-9]{40}\|[^]]*\]\]' changes.md 2>/dev/null || true)"
  while read -r placeholder; do
    [ -z "$placeholder" ] && continue
    sha="$(printf '%s' "$placeholder" | sed 's/\[\[\([^|]*\)|.*/\1/')"
    email="$(printf '%s' "$placeholder" | sed 's/\[\[[^|]*|\([^|]*\)|.*/\1/')"
    name="$(printf '%s' "$placeholder" | sed 's/\[\[[^|]*|[^|]*|\([^]]*\)\]\]/\1/')"
    username=""
    if [[ "$email" =~ ^[0-9]+\+([^@]+)@users\.noreply\.github\.com$ ]]; then
      username="${BASH_REMATCH[1]}"
    elif [[ "$email" =~ ^([^@+\[]+)@users\.noreply\.github\.com$ ]]; then
      username="${BASH_REMATCH[1]}"
    fi
    if [ -n "$username" ]; then
      sed -i "s|\[\[$sha[^]]*\]\]|@$username|g" changes.md
    else
      sed -i "s|\[\[$sha[^]]*\]\]|$name|g" changes.md
    fi
  done <<< "$remaining"
}

collect_pr_numbers() {
  git log "$range" --format='%H%x09%s' 2>/dev/null | while IFS=$'\t' read -r sha subject; do
    printf '%s\n' "$subject" | grep -oE 'Merge pull request #[0-9]+|#[0-9]+' | grep -oE '[0-9]+' || true
    gh api graphql \
      -f owner="${repo%%/*}" \
      -f name="${repo#*/}" \
      -f oid="$sha" \
      -f query='query($owner:String!, $name:String!, $oid:GitObjectID!) { repository(owner:$owner, name:$name) { object(oid:$oid) { ... on Commit { associatedPullRequests(first: 10) { nodes { number } } } } } }' \
      --jq '.data.repository.object.associatedPullRequests.nodes[].number' 2>/dev/null || true
  done | sort -n | uniq
}

generate_community_section() {
  pr_numbers="$(collect_pr_numbers)"
  if [ -z "$pr_numbers" ]; then
    return
  fi

  {
    echo "### Community Contributions"
    echo
    echo "Thank you to our community contributors!"
    echo
    while read -r pr; do
      [ -z "$pr" ] && continue
      pr_json="$(gh api "repos/$repo/pulls/$pr" 2>/dev/null || true)"
      [ -z "$pr_json" ] && continue
      title="$(printf '%s' "$pr_json" | jq -r '.title // empty')"
      author="$(printf '%s' "$pr_json" | jq -r '.user.login // empty')"
      url="$(printf '%s' "$pr_json" | jq -r '.html_url // empty')"
      [ -z "$title" ] || [ -z "$author" ] || [ -z "$url" ] && continue
      echo "- $title ([#$pr]($url)) by @$author"
    done <<< "$pr_numbers"
    echo
  } > community.md
}

generate_changelog
normalize_changelog
resolve_author_placeholders
generate_community_section

install="opencode plugin opencode-agent-variants --global"
if [ "$npm_tag" != "latest" ]; then
  install="opencode plugin opencode-agent-variants@$npm_tag --global"
fi

experimental_note=""
if [ "$prerelease" = "true" ]; then
  experimental_note="$(cat <<EOF
> [!WARNING]
> This is a prerelease from the \`$channel\` channel. It may contain incomplete or unstable changes.
>
> Use the exact version \`$version\` when reporting issues.

EOF
)"
fi

compare_url=""
if [ -n "$previous_tag" ]; then
  compare_url="https://github.com/$repo/compare/$previous_tag...$tag"
fi

: > release-notes.md
if [ -n "$experimental_note" ]; then
  printf '%s\n\n' "$experimental_note" >> release-notes.md
fi

cat >> release-notes.md <<EOF
## Package

| Field | Value |
| ----- | ----- |
| Version | \`$version\` |
| npm tag | \`$npm_tag\` |
| Channel | \`$channel\` |
| Commit | [\`${commit_sha:0:7}\`](https://github.com/$repo/commit/$commit_sha) |

## Install

\`\`\`sh
$install
\`\`\`

## What's Changed

$(cat changes.md)

EOF

if [ -s community.md ]; then
  cat community.md >> release-notes.md
fi

cat >> release-notes.md <<EOF
## Links

- [npm package](https://www.npmjs.com/package/opencode-agent-variants)
- [Repository](https://github.com/$repo)
- [Issues](https://github.com/$repo/issues)
EOF

if [ -n "$compare_url" ]; then
  echo "- [Full changelog]($compare_url)" >> release-notes.md
fi
