# How-To: Test CI Workflows Locally

**Status:** Current (2026-08-08).
**Companion:** `.gitea/workflows/ci.yml` and its byte-identical `.github/` twin.
**Context:** Forgejo issue #70.

Workflow changes used to be testable only by committing and pushing. That loop
produced four check-ins in twenty minutes — a land, a revert, and two abandoned
attempts — none of which was a *logic* failure. They were "does this pipeline run
at all" failures, and every one of them was catchable locally.

`forgejo-runner exec` runs a workflow on your machine against Docker, with no
Forgejo server involved. It is the **same binary** that runs your CI.

---

## 1. Why this binary and not `act`

`forgejo-runner exec` is Forgejo's wrapper around nektos/act, and nixpkgs ships
it at the same version as the runner image in the cluster:

```bash
nix eval --raw nixpkgs#forgejo-runner.version   # 12.13.2
```

That matches `image: code.forgejo.org/forgejo/runner:12.13.2` in the runner
StatefulSet. Same binary, same vendored act, same behaviour. Plain `act` is also
in nixpkgs and works, but you would be testing a different act version than the
one that will actually run your job.

**Re-check that match whenever you bump either side.** The moment the versions
diverge, this document's central claim — that local and CI run the same code —
stops being true.

---

## 2. Prerequisites

- **Docker running locally.** `docker info` must succeed. The runner talks to
  `/var/run/docker.sock`.
- **Nix.** No install step needed; `nix run` fetches the binary (~6.7 MiB) and
  caches it.
- **Disk.** The first run pulls `catthehacker/ubuntu:act-latest`, which is over
  a gigabyte.

---

## 3. The command

```bash
nix run nixpkgs#forgejo-runner -- exec \
  -W .gitea/workflows/ci.yml \
  -i catthehacker/ubuntu:act-latest \
  --default-actions-url https://data.forgejo.org \
  -j test-go
```

Every flag there is load-bearing, because **none of the defaults match our
setup**:

| Flag | Default | Why ours differs |
|---|---|---|
| `-W` | `./.forgejo/workflows/` | We have no `.forgejo/`. Point at the **file**, not the directory — the directory also contains `release.yml`, which recurses in and plans a `build-linux` job you did not ask for. |
| `-i` | `node:20-bullseye` | Our runner labels map `ubuntu-latest` → `catthehacker/ubuntu:act-latest`. `build-go` and `credits` `sudo apt-get` GTK/WebKit, so the Debian/node default tests something we never run. |
| `--default-actions-url` | `https://code.forgejo.org` | Our runners resolve bare `actions/*` from `data.forgejo.org` (see the note in `ci.yml`). |
| `-j` | all jobs | Run one job. See below. |

List what is available without running anything:

```bash
nix run nixpkgs#forgejo-runner -- exec -W .gitea/workflows/ci.yml --list
```

---

## 4. Which job to run

| Job | Local cost | Worth running? |
|---|---|---|
| `test-go` | moderate | **Yes** — the usual first check. |
| `frontend` | low | **Yes** — fastest signal on the npm/vitest path. |
| `build-go` | high | Only when you touched the build. It `apt-get`s `libgtk-3-dev` and `libwebkit2gtk-4.1-dev` on **every** run with no apt cache locally. |
| `credits` | high | Rarely. Gated on dependency changes in CI; locally it does the same apt install plus `npm ci`. |

Default event is `push`. Use `-E pull_request` to exercise the PR branches —
notably `credits`, whose filter step takes a different path on each.

---

## 5. What this does NOT reproduce

Be clear about the boundary, because a false sense of coverage is worse than
none.

- **The shared Actions cache server.** `actions/cache`, `setup-go`'s `cache:
  true` and `setup-node`'s `cache: 'npm'` do not reach
  `runner-cache-server.forgejo.svc.cluster.local`. Locally they use act's own
  cache. **Cache-hit behaviour is not tested here** — but note that none of the
  failures this tool exists to prevent were cache failures.
- **Cluster networking.** Job containers in CI run on the pod network and can
  reach in-cluster services. Locally they are on a Docker bridge and cannot.
- **Secrets.** None of the CI jobs use `${{ secrets.* }}` today. If that
  changes, pass them explicitly with `-s NAME=value`; they are not read from the
  Forgejo instance.
- **Runner concurrency.** CI has three replicas at `capacity: 1`, so four jobs
  means one queues. Locally you run one job at a time (§6).

---

## 6. Gotchas

**One run at a time.** Concurrent `exec` invocations share
`~/.cache/actcache/bolt.db` and the second dies with:

```
Error: Open(/home/stephen/.cache/actcache/bolt.db): timeout
```

A crashed or backgrounded run can leave the lock held. Clear it with:

```bash
pgrep -af "[b]in/forgejo-runner"     # bracket avoids matching your own shell
rm -rf ~/.cache/actcache
```

The bracket in `[b]in` matters — a bare `pkill -f forgejo-runner` matches the
shell running it and kills your own terminal.

**Piping hides the exit code.** `... | tail -60` reports `tail`'s status, not the
runner's. Redirect to a file and check `$?`, or read the last lines afterwards.

**Keep the two workflow files byte-identical.** `exec` runs whichever file you
point `-W` at. If `.gitea/` and `.github/` have drifted you may be validating the
copy that never runs. They diverged silently once already:

```bash
diff .gitea/workflows/ci.yml .github/workflows/ci.yml   # must be empty
```

---

## 7. Making it permanent (not done)

The flags in §3 are easy to get wrong and there is no reason to retype them. The
natural shape follows `wailsWrapped` in `flake.nix` — a real store package that
bakes in the correct flags so the bare command does the right thing — adding
`forgejo-runner` to the devShell `packages` and a `writeShellScriptBin "ci-local"`
alongside it, so this becomes `ci-local test-go`.

**This has not been built.** Until it is, use the full command above.
