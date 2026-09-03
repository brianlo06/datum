#!/bin/sh
# Fetch the vendored OpenSCAD libraries at their pinned commits.
#
# Runs at image build time, where network access is available; the running
# sandbox has none. Each library is cloned, checked out at an immutable commit,
# and stripped of its git metadata. A manifest with a digest over the pinned
# refs is written alongside, and that digest is folded into every build hash so
# bumping a library invalidates cached geometry instead of silently changing it.
set -eu

MANIFEST="${1:-libraries.json}"
DEST="${2:-/opt/openscad-libraries}"

mkdir -p "$DEST"

# Extracted with sed rather than jq to keep the build stage dependency-free;
# this relies on the manifest keeping one key per line.
names=$(sed -n 's/.*"name": "\([^"]*\)".*/\1/p' "$MANIFEST")
repos=$(sed -n 's/.*"repo": "\([^"]*\)".*/\1/p' "$MANIFEST")
refs=$(sed -n 's/.*"ref": "\([^"]*\)".*/\1/p' "$MANIFEST")

n_names=$(echo "$names" | wc -l)
n_repos=$(echo "$repos" | wc -l)
n_refs=$(echo "$refs" | wc -l)
if [ "$n_names" -ne "$n_repos" ] || [ "$n_names" -ne "$n_refs" ]; then
  echo "manifest is malformed: $n_names names, $n_repos repos, $n_refs refs" >&2
  exit 1
fi

i=1
for repo in $repos; do
  name=$(echo "$names" | sed -n "${i}p")
  ref=$(echo "$refs" | sed -n "${i}p")
  echo "vendoring $name @ $ref"
  rm -rf "$DEST/$name"
  git clone --quiet --filter=blob:none "$repo" "$DEST/$name"
  git -C "$DEST/$name" checkout --quiet "$ref"
  # Keep the licence, drop everything else git-related.
  rm -rf "$DEST/$name/.git" "$DEST/$name/.github"
  i=$((i + 1))
done

cp "$MANIFEST" "$DEST/manifest.json"

# A digest over the pinned refs identifies this exact library set.
echo "$refs" | sort | sha256sum | cut -d' ' -f1 > "$DEST/digest"
echo "library set digest: $(cat "$DEST/digest")"

du -sh "$DEST" 2>/dev/null || true
