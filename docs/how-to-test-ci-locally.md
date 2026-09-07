# How-To: Test CI Workflows Locally

**Status:** Current (2026-09-07).
**Companion:** `.forgejo/workflows/ci.yml`, `.forgejo/workflows/publish-ci-image.yml`.
**Context:** Forgejo issues #70, #136.

Workflow changes used to be testable only by committing and pushing. That loop
produced four check-ins in twenty minutes — a land, a revert, and two abandoned
attempts — none of which was a *logic* failure. They were "does this pipeline run
at all" failures, and every one of them was catchable locally.

`forgejo-runner exec` runs a workflow on your machine against Docker, with no
Forgejo server involved. It is the **same binary** that runs your CI.

---

## 1. Why this binary and not `act`

`forgejo-runner exec` is Forgejo's wrapper around nektos/act. When the version
nixpkgs ships matches the runner image in the cluster, local and CI run the same
binary, the same vendored act, the same behaviour:

```bash
nix eval --raw nixpkgs#forgejo-runner.version   # compare with the runner
                                                # StatefulSet's image tag
```

**Check that match before you trust a local run.** nixpkgs moves on its own; at
the last check (2026-09-07) it was ahead at 13.1.0. Plain `act` is also in
nixpkgs and works, but it is a third version again.

---

## 2. Prerequisites

- **Docker running locally.** `docker info` must succeed. The runner talks to
  `/var/run/docker.sock`.
- **Nix.** No install step needed; `nix run` fetches the binary (~6.7 MiB) and
  caches it.
- **The project image, built locally.** Jobs run in `stephen/sieve-ci`, which
  the cluster pulls from a registry your machine cannot reach. Build and load it
  first — about 3 GB, a minute when the store is warm:

  ```bash
  nix run .#ci-image | docker load
  docker tag stephen/sieve-ci:latest \
    registry-mirror.image-repository.svc.cluster.local:5002/stephen/sieve-ci:latest
  ```

  The second tag is what `ci.yml`'s `container:` names, and `container:` wins
  over `-i`. With the local tag in place and `--pull=false`, the runner uses the
  image you just built.

---

## 3. The command

```bash
nix run nixpkgs#forgejo-runner -- exec \
  -W .forgejo/workflows/ci.yml \
  -i stephen/sieve-ci:latest \
  --default-actions-url https://data.forgejo.org \
  --pull=false \
  -j test-go
```

Every flag there is load-bearing, because **none of the defaults match our
setup**:

| Flag | Default | Why ours differs |
|---|---|---|
| `-W` | `./.forgejo/workflows/` | Point at the **file**, not the directory — the directory also contains `release.yml`, which recurses in and plans a `build-linux` job you did not ask for. |
| `-i` | `node:20-bullseye` | The image every job's toolchain lives in. Each job also names it in `container:`, which act honours ahead of `-i` — hence the mirror-path tag in §2. |
| `--pull=false` | pull | The mirror path is unreachable from a laptop; without this the runner tries to pull it and fails. |
| `--default-actions-url` | `https://code.forgejo.org` | Our runners resolve bare `actions/*` from `data.forgejo.org` (see the note in `ci.yml`). |
| `-j` | all jobs | Run one job. See below. |

List what is available without running anything:

```bash
nix run nixpkgs#forgejo-runner -- exec -W .forgejo/workflows/ci.yml --list
```

---

## 4. Which job to run

| Job | Local cost | Worth running? |
|---|---|---|
| `test-go` | moderate | **Yes** — the usual first check. |
| `frontend` | low | **Yes** — fastest signal on the npm/vitest path. |
| `build-go` | moderate | When you touched the build. The GTK/WebKit headers come from the image's devShell, so it is a compile and nothing else. |
| `credits` | moderate | Rarely. Gated on dependency changes in CI; locally it does `npm ci` and a `go-licenses` run, both over the network. |

Only Go module and npm downloads use the network in the steady state. The
toolchain is `nix develop` out of the image's store. A job that fetches or builds
a compiler is running a flake change against the previous image — `ci.yml` is
deliberately not `--offline`, so that run degrades instead of failing — and
`publish-ci-image.yml` is rebuilding the image behind it. Its probe job is where
`--offline` is enforced.

Default event is `push`. Use `-E pull_request` to exercise the PR branches —
notably `credits`, whose filter step takes a different path on each.

---

## 5. What this does NOT reproduce

Be clear about the boundary, because a false sense of coverage is worse than
none.

- **The shared Actions cache server.** The `actions/cache` steps on `~/go/pkg/mod`,
  `~/.cache/go-build` and `~/.npm` do not reach
  `runner-cache-server.forgejo.svc.cluster.local`. Locally they time out and warn.
  **Cache-hit behaviour is not tested here** — but note that none of the failures
  this tool exists to prevent were cache failures.
- **The registry.** CI pulls `sieve-ci:latest` through the in-cluster proxy;
  locally you supply the tag yourself (§2), so a local pass says nothing about
  whether the published image is current.
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

**Every job logs a `bash-interactive` build failure.** `nix develop` runs its
command under `bashInteractive`, which is in no mkShell's closure and so is not in
the image. Offline it cannot be built, nix prints the whole 531-derivation
dependency cascade and `error (ignored)`, then falls back and runs the step. It is
noise, not a failure — the step's own exit code is what counts. It belongs in
ci-base's `basePackages`; `extraPackages` cannot carry it (the layer builder fails
creating its gcroot).

**Piping hides the exit code.** `... | tail -60` reports `tail`'s status, not the
runner's. Redirect to a file and check `$?`, or read the last lines afterwards.

**One workflow directory only.** Forgejo looks for `.forgejo/workflows`, then
`.gitea/workflows`, then `.github/workflows`, and uses the first directory that
exists, even if it holds no workflows. Adding a second directory silently
disables the first. `.github/workflows` holds only the macOS release build, which
Forgejo never reads because `.forgejo/workflows` exists.

---

## 7. Making it permanent (not done)

The flags in §3 are easy to get wrong and there is no reason to retype them. The
natural shape follows `wailsWrapped` in `flake.nix` — a real store package that
bakes in the correct flags so the bare command does the right thing — adding
`forgejo-runner` to the devShell `packages` and a `writeShellScriptBin "ci-local"`
alongside it, so this becomes `ci-local test-go`.

**This has not been built.** Until it is, use the full command above.
