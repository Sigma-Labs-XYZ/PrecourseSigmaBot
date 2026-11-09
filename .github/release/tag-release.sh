#!/usr/bin/env bash
# tag-release.sh: in a checkout of the dispatched dev commit, commits the release versions
# and pushes only the v<version> tag at it. Writes sha=<commit> to $GITHUB_OUTPUT.
# Runs git only, with hooks disabled; no repository code.
. "$(dirname "$0")/lib.sh"

tag="v$OPENCODE_VERSION"
git ls-files -z -- '*package.json' bun.lock | xargs -0 sed -i -E "s/\"version\": \"[^\"]+\"/\"version\": \"$OPENCODE_VERSION\"/g"

if git diff --name-only | grep -vE '(^|/)package\.json$|^bun\.lock$'; then
  die "The release commit may only change versions"
fi

git -c core.hooksPath=/dev/null \
  -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --no-verify -q -am "release: $tag"

# A rerun reuses the tag when it holds the same tree.
existing=$(git ls-remote origin "refs/tags/$tag" | cut -f1)
if [ -n "$existing" ]; then
  git fetch -q --depth=1 origin "refs/tags/$tag"
  [ "$(git rev-parse "$existing^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] || die "Tag $tag already exists with different contents"
  echo "sha=$existing" >> "$GITHUB_OUTPUT"
  exit 0
fi
git push -q origin "HEAD:refs/tags/$tag"
echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
