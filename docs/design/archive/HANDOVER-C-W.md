# Handover: C-W (block-update → block-op convergence)

## Where things stand
- Branch: `feature/block-op-create-convergence`. Last commit: `00f66c3`
  ("Slice-paste sync (C-V/P-D), paste self-kind round-trip, block delete fixes").
- Working tree is clean except untracked junk to IGNORE (don't commit):
  `debug screenshots/*.png`, `docs/design/plans/rabbit hole mess` (old plans folder, since deleted), `log_iotc.txt`.
- Full suite green at handover: `go build ./...`, `go test ./...`, and
  `cd frontend && npx vitest run` (101 passed).

## What was just finished (context, already committed)
The block-document-model "create convergence" arc. All UI-triggered creation now
flows through ONE positioned path: `block-op {create-block, kind, attrs, index}`
→ `HandleBlockOp` → `insertBlockAt(index)`. Retired the legacy `create-block` WS
message + `handleCreateBlock`. Then in the latest commit:
- C-V/P-D: `sieve/slice` paste is reconstructed SERVER-side (POST
  `/api/editor/paste-slice` → `EditorService.HandlePasteSlice` → `HandlePaste`,
  which runs `block.FirstPasteMatch` + `Transform`, mints a fresh id, inserts via
  block-op). Render-back reuses `blockToNodes` + baselines via `noteServerBlock`.
- C-X: `FirstPasteMatch` self-kind pass (copied mermaid code round-trips as code).
- C-Y: whole-block keyboard delete (blockChrome `handleKeyDown` for gutter
  block-range; ai-block guard narrowed to in-body editing only).

## The task: C-W (see docs/TECH-DEBT.md "## C-W")
`block-update` is the LAST pre-block-op mutation message still riding its own
bespoke WS path (`create-block` retired; `doc-update` legitimately kept as the
markdown-mode verbatim breakglass). Converge it so `block-op` is the single
granular mutation path (create/update/delete), with only `doc-update` beside it.

Current state: `sieve:block-update` (frontend) → `handleBlockUpdate` (ws_handler.go)
→ a path that MERGES partial attrs + runs the processor's `OnChange` + dispatches
the job + notifies. Meanwhile `HandleBlockOp`'s update case (`applyOpTo` /
`ApplyOp` update-block in shadow_document.go) currently REPLACES attrs and does
none of that (no merge, no OnChange, no dispatch, no notify).

Retire when:
1. `HandleBlockOp`'s update-block case gains the structured partial-attrs MERGE +
   `OnChange` + job dispatch + notify (mirror of the create case).
2. `sieve:block-update` emits a `block-op {update-block, blockId, attrs}` instead
   of the bespoke message.
3. Remove `handleBlockUpdate` + the `case "block-update"` from ws_handler.go.

This is the MIRROR of the create convergence — use that as the template
(`createBlockWithID` / `notifyBlockCreated` / the create-block path in
`HandleBlockOp`). Preserve the existing T-A flaky-test fix:
`TestHandleBlockUpdate_notifySendsSnapshotUnderLock` observes `attrs["source"]`
and relies on the block being DISPATCHED so `OnChange` early-returns — keep that
invariant (or update the test deliberately if the convergence changes it).

## Key files
- requesthandlers/ws_handler.go — `handleBlockUpdate`, `case "block-update"`,
  `OnBlockCreated`/notify wiring (the create side to mirror).
- sieve/services/editor_service.go — `HandleBlockOp`, `createBlockWithID`,
  `notifyBlockCreated` (~lines 200–470).
- sieve/block/shadow_document.go — `ApplyOp` / update-block case (~line 222–270),
  `DeleteBlockAttr`.
- frontend: grep `sieve:block-update` and `handleBlockUpdate` for the emit site.

## Conventions (project)
- No loose functions — behaviour on the owning type/service.
- White-box tests live in the type's package; cross-package via public API only.
- Use language-server MCP tools over grep for navigation.
- PRs go to self-hosted Forgejo via `tea` (nix-shell --run), NOT gh; commits have
  NO Co-Authored-By trailer.
- Verify with `go build ./... && go test ./...` and `cd frontend && npx vitest run`.
  Live WS round-trips have no automated coverage — flag for manual `wails dev`.

## Start by
Reading docs/TECH-DEBT.md C-W, then `handleBlockUpdate` in ws_handler.go and the
create-block case in `HandleBlockOp`, and proposing the convergence diff before
editing.
