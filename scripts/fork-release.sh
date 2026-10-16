#!/usr/bin/env bash
# Builds the fork's VS Code extension as <upstream version>+<suffix> and, with
# --publish, tags it and uploads the VSIX as a GitHub release on the fork.
set -euo pipefail

usage() {
	cat <<EOF
Usage: scripts/fork-release.sh --repo OWNER/NAME --suffix SUFFIX [--publish] [ref]

Builds release/cline-<upstream version>+<suffix>.vsix from ref (default
origin/main), which must be on origin/main, with release notes in
release/cline-<upstream version>+<suffix>.md listing the PRs merged from
OWNER's branches.

  --repo OWNER/NAME  the fork's GitHub repository
  --suffix SUFFIX    appended to the upstream version, e.g. 4.1.24+SUFFIX (semver build metadata)
  --publish          also create the annotated tag v<version>, push it to
                     origin and create the GitHub release on OWNER/NAME
EOF
}

die() {
	echo "error: $*" >&2
	exit 1
}

repo=
suffix=
publish=false
ref=origin/main
while [[ $# -gt 0 ]]; do
	case "$1" in
	--repo)
		repo=${2:?--repo needs a value}
		shift
		;;
	--suffix)
		suffix=${2:?--suffix needs a value}
		shift
		;;
	--publish) publish=true ;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		usage >&2
		exit 2
		;;
	*) ref=$1 ;;
	esac
	shift
done

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo OWNER/NAME is required"
[[ "$suffix" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]] || die "--suffix is required and must be semver build metadata"
owner=${repo%%/*}

tools=(git jq bun)
$publish && tools+=(gh)
for tool in "${tools[@]}"; do
	command -v "$tool" >/dev/null || die "$tool not found"
done

root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")

git fetch --quiet --tags origin main
sha=$(git rev-parse --verify "$ref^{commit}")
git merge-base --is-ancestor "$sha" origin/main || die "$ref is not on origin/main"

base=$(git show "$sha:apps/vscode/package.json" | jq -r .version)
version="$base+$suffix"
tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null ||
	git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
	die "tag $tag already exists"
fi

out="$root/release"
vsix="$out/cline-$version.vsix"
notes="$out/cline-$version.md"
work="$root/.worktrees/release-$version"
mkdir -p "$out"

prev=$(git describe --tags --abbrev=0 --match "v*+$suffix" "$sha^" 2>/dev/null || true)
{
	echo "Based on upstream Cline v$base.${prev:+ Changes since $prev:}"
	echo
	while read -r commit; do
		pr=$(git log -1 --format=%s "$commit" | sed -n "s|^Merge pull request #\([0-9]*\) from $owner/.*|\1|p")
		[[ -n "$pr" ]] || continue
		echo "- $(git log -1 --format=%b "$commit" | head -n 1) (#$pr)"
	done < <(git rev-list --first-parent --merges "${prev:+$prev..}$sha")
	echo
	echo "Install: \`code --install-extension cline-$version.vsix\`"
} >"$notes"

git worktree add --detach "$work" "$sha"
trap 'git -C "$root" worktree remove --force "$work"' EXIT

cd "$work"
bun install
git checkout bun.lock
bun run build:sdk

cd apps/vscode
jq --tab --arg v "$version" '.version = $v' package.json >package.json.tmp
mv package.json.tmp package.json
# The workspace vsce: `npx vsce` resolves to the deprecated vsce 2.x package.
./node_modules/.bin/vsce package --no-dependencies --allow-package-secrets sendgrid --out "$vsix"

cd "$root"
echo
echo "Built $vsix ($sha)"
echo "Notes in $notes"

if ! $publish; then
	echo
	echo "To publish:"
	echo "  git tag -a $tag -m 'Cline $version' $sha"
	echo "  git push origin refs/tags/$tag"
	echo "  gh release create $tag '$vsix' --repo $repo --title 'Cline $version' --notes-file '$notes' --verify-tag"
	exit 0
fi

git tag -a "$tag" -m "Cline $version" "$sha"
git push origin "refs/tags/$tag"
gh release create "$tag" "$vsix" --repo "$repo" --title "Cline $version" --notes-file "$notes" --verify-tag
