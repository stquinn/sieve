image: git.stephenquinn.ie/stephen/sieve-ci:latest

# Sieve: class code-pr

`CLAUDE.md` is the authority on conventions, package boundaries and words; this file only
says what a pull request must carry and how it is checked. Read `docs/how-to-idiomatic-js.md`
before touching JavaScript and `frontend/src/static/contract/` before touching a lens.

## Gates

Every one green before the PR, run from the checkout inside the devShell:

- `nix develop -c env CGO_ENABLED=0 go vet ./...`
- `nix develop -c env CGO_ENABLED=0 go test ./...`
- `nix develop -c go build -tags webkit2_41 ./...`
- `nix develop -c sh -c 'cd frontend && npm ci && npm test'`
- When `go.mod`, `go.sum`, `frontend/package*.json` or `tools/gencredits/` changed:
  `nix develop -c go run ./tools/gencredits` and `git diff --exit-code third-party-licenses.json`.

A red gate is a `blocked` outcome with the failure quoted, never a PR.

## Evidence

The PR body carries a **UAT script**: numbered steps a human follows in the running app to
see the change, with the expected result of each. UI changes carry a screenshot or a short
screencast, attached as a PR comment, of the state the script reaches. Test changes name the
existing tests leveraged or updated and why any were deleted (the test-economy rule).

## Paths

No allowlist: the whole repository, under `CLAUDE.md`'s rules. Do not edit
`third-party-licenses.json` by hand, `docs/design/plans/`, or `.github/workflows/`.
