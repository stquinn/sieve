#!/usr/bin/env bash
# Cut a release: bump sieveVersion in flake.nix, commit, tag v<version>, push.
#
#   tools/release.sh 0.36.1          asks before pushing
#   tools/release.sh 0.36.1 --yes    pushes without asking
#
# The Forgejo release workflow refuses a tag whose number differs from
# flake.nix's sieveVersion (the number a Nix install reports). Before that check
# existed, pushing a tag was the whole release; since 2026-09-07 the constant
# has to be bumped first, and v0.34.0-v0.36.0 were tagged without it and never
# published. This script makes the bump and the tag one step again.
set -euo pipefail

usage() {
  echo "Usage: tools/release.sh <major.minor.patch> [--yes]" >&2
  exit 1
}

die() {
  echo "release: $*" >&2
  exit 1
}

version="${1:-}"
assume_yes=0
case "${2:-}" in
  "") ;;
  --yes | -y) assume_yes=1 ;;
  *) usage ;;
esac
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
tag="v$version"

cd "$(git rev-parse --show-toplevel)"

# Refuse anything that would tag a commit other than what is on origin/main.
[[ $(git branch --show-current) == main ]] || die "not on main"
[[ -z $(git status --porcelain --untracked-files=no) ]] || die "uncommitted changes to tracked files"

git fetch --quiet --tags origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] ||
  die "main is not in sync with origin/main (pull or push first)"

git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "$tag already exists"

current=$(sed -n 's/^ *sieveVersion = "\([^"]*\)";.*/\1/p' flake.nix)
[[ -n $current ]] || die "could not find sieveVersion in flake.nix"

# The newest existing tag, not the flake constant, is the floor: the constant
# fell behind the tags once already.
latest_tag=$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n1)
latest=${latest_tag#v}
if [[ -n $latest ]] && [[ $(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n1) != "$version" || $latest == "$version" ]]; then
  die "$version is not newer than the latest tag $latest_tag"
fi

sed -i "s/^\( *sieveVersion = \)\"[^\"]*\";/\1\"$version\";/" flake.nix
grep -q "sieveVersion = \"$version\";" flake.nix || die "bumping flake.nix failed"

git commit --quiet -m "Release $tag" -- flake.nix
git tag "$tag"

echo "Committed and tagged $tag (sieveVersion $current -> $version, latest tag was ${latest_tag:-none})."

if [[ $assume_yes == 0 ]]; then
  read -r -p "Push main and $tag to origin? [y/N] " answer
  if [[ ! $answer =~ ^[Yy] ]]; then
    echo "Not pushed. To undo: git tag -d $tag && git reset --hard HEAD~1"
    exit 0
  fi
fi

# Atomic, so the release workflow never sees a tag whose commit is not on main.
git push --atomic origin main "refs/tags/$tag"
echo "Pushed. The Forgejo release workflow is now building $tag."
