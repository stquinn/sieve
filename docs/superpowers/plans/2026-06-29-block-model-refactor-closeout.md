# Block-Model Refactor Close-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the non-UI loose ends of the block-document-model refactor so the merged arc is internally consistent with its own design principles, and retire the backend-authoritative prose-id debt (B-A).

**Architecture:** The block-model arc (Stages A–D) shipped and merged (#18). This plan closes the *non-affordance* debt only: it attaches the remaining loose Go functions to their owning types (the project's "no loose functions" principle), clears stale/flaky/edge-case test debt, seeds markdown-mode from Go (F-A), retires the frontend prose-id mint (B-A), and regroups the flat JS `static/` dir to mirror the Go packages (S-A JS half). Every rail/lineage/affordance UI item is **explicitly out of scope** — those are re-planned wholesale as a Stage E/F affordance re-brainstorm (TECH-DEBT **U-A**).

**Tech Stack:** Go (`go test ./...`, `-race` for `sieve/services`), vanilla JS + vitest (`cd frontend && npx vitest run`), Wails v2 / WebKitGTK for in-app verification.

## Global Constraints

- **No affordance UI in this plan.** Do not touch rail/bracket/highlight/chrome CSS or the lineage/jump affordances. They are deferred to the Stage E/F re-brainstorm (TECH-DEBT **U-A**). See `[[project_editor_layout_affordances_redesign]]`.
- **No loose/free functions.** Behaviour belongs as a method on the type or service that owns its data (CLAUDE.md Design Principles). This plan *applies* that principle to the named backlog; do not introduce new free funcs.
- **Tests live with the type they exercise.** White-box tests (touching `Attrs`/unexported methods) stay in the type's package; cross-package tests use the public API only.
- **Backend is the document source of truth.** Any doc-mutating op renders by placing the server's node at the server's index as a *tracked* PM transaction; never `softReloadContent` for an operation (it wipes undo). See `[[feedback_backend_is_doc_source_of_truth]]`.
- **Green bar is the refactor safety net.** Tasks 1–4 add no new behaviour; the existing suites are the contract. Every task ends with the full relevant suite green and one commit.
- **No `Co-Authored-By` trailer** on commits (`[[feedback_no_coauthor]]`).
- **Verify before claiming done** — run the command, read the output, then check the box.

---

## Out of Scope / Deferred (do NOT do here)

- **All Editor-Layout affordances** (chrome §3, columns §6, lineage rail §8, doc-map §8) → TECH-DEBT **U-A**, Stage E/F affordance re-brainstorm. Includes the indigo jump-to-ASK rail (the blob; belongs in the gutter gap left of the line number) and B-D (moot — the orange chain already paints on prose).
- **B-A** (prose-id mint → backend authoritative) and **F-A** (markdown-mode seeding) get their **own dedicated plans** — they need code/design investigation and (B-A) its own branch. Tasks 5 and 6 below are *meta-tasks* that produce those plans, not the implementation. This is the scope-split the writing-plans skill mandates; fabricating TDD code for them here would be a placeholder.

---

## Task 1: Attach `handle_gc` free funcs to an owning type (no-loose-functions, part 1)

**Files:**
- Modify: `sieve/block/handle_gc.go` (`collectHandles`, `gcRefs`, `gcAliases`, `gcAliasesBlocks` — currently package-level free funcs, called only by their own white-box tests; not yet wired into the live save pipeline per the file header)
- Modify: `sieve/block/handle_gc_test.go` (white-box; stays in `block`)

**Owning-type decision (settled 2026-06-29):** Handle GC is the **ShadowDocument's own internal job** — it reads `answersTo()`, walks the block tree, and filters each block's `Aliases`, all over data `ShadowDocument` owns (`s.Blocks`). A separate service inspecting that from outside is feature-envy (the loose-function smell). So these become methods on the data's owner. Cohesive split: the two transforms that need the *whole tree* go on `ShadowDocument`; the one that cleans a *single block's own outgoing refs* goes on `SieveBlock` (mirroring the existing `answersTo()` method). They take only the cross-cutting `resolvable`/`referenced` set as a parameter — never the doc's own blocks (the Stage A/B "prove in isolation" param shape is dropped). The future Stage E/F save-wiring adds the public orchestrator as one more `ShadowDocument` method.

**Interfaces:**
- Produces: `(*ShadowDocument).collectHandles() map[string]bool` (resolution index over `s.Blocks`); `(*ShadowDocument).gcAliases(referenced map[string]bool) []SieveBlock` (undo-safe copy — input tree not mutated); `(SieveBlock).gcRefs(resolvable map[string]bool) []string` (this block's outgoing refs, filtered + first-seen-deduped). Unexported — internal save-time concern; the Stage E/F orchestrator (also a `ShadowDocument` method) chains them.

- [ ] **Step 1: Add `collectHandles` + `gcAliases` to ShadowDocument** (in `handle_gc.go`, package `block`), reading `s.Blocks` directly

```go
// collectHandles builds the resolution index over this document's blocks: every
// block's primary ID plus its aliases. A ref resolves iff its target is here.
func (s *ShadowDocument) collectHandles() map[string]bool {
	out := map[string]bool{}
	for _, b := range s.Blocks {
		for _, h := range b.answersTo() {
			out[h] = true
		}
	}
	return out
}

// gcAliases returns a copy of this document's block tree with each block's alias
// handles filtered to those still referenced. Primary IDs are never dropped. The
// live tree is not mutated, so undo can restore the prior assignment.
func (s *ShadowDocument) gcAliases(referenced map[string]bool) []SieveBlock {
	if s.Blocks == nil {
		return nil
	}
	out := make([]SieveBlock, len(s.Blocks))
	for i, b := range s.Blocks {
		var kept []string
		for _, a := range b.Aliases {
			if referenced[a] {
				kept = append(kept, a)
			}
		}
		b.Aliases = kept
		out[i] = b
	}
	return out
}
```

- [ ] **Step 2: Add `gcRefs` to SieveBlock** (the block cleans its own outgoing refs; use the actual outgoing-ref field on `SieveBlock` — verify its name before coding)

```go
// gcRefs returns this block's outgoing refs filtered to those that resolve
// against the index, deduped in first-seen order.
func (b SieveBlock) gcRefs(resolvable map[string]bool) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range b.outgoingRefs() { // ← replace with the real ref accessor/field
		if resolvable[r] && !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}
```
(Delete the old free funcs `collectHandles`/`gcRefs`/`gcAliases` and the redundant `gcAliasesBlocks` indirection.)

- [ ] **Step 3: Update the white-box tests** in `handle_gc_test.go` (stays in `block`) to construct real receivers: build a `ShadowDocument{Blocks: doc}` for `collectHandles`/`gcAliases`, and a `SieveBlock` carrying the refs for `gcRefs`. Assertions unchanged. This also strengthens them — they now exercise the real owned shape, not bare slices.

- [ ] **Step 4: Run the block suite — must stay green**

Run: `go test ./sieve/block/...`
Expected: PASS (all existing handle_gc tests pass through the new methods).

- [ ] **Step 5: Full build + vet**

Run: `go build ./... && go vet ./sieve/block/...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/block/handle_gc.go sieve/block/handle_gc_test.go
git commit -m "refactor(block): own handle GC on ShadowDocument/SieveBlock, retire free funcs"
```

---

## Task 2: Attach the AIService-private free funcs to AIService (no-loose-functions, part 2)

> **Scope decision (2026-06-29):** absorb **all 5** AIService-private free funcs, not just `eval.go`'s two. Moving `detectContentType`/`extractJSONFallback` onto `*AIService` while leaving three identical siblings loose in `ai_service.go` is the asymmetry `[[feedback_prefer_uniform_patterns]]` warns against. All five are called only from AIService code (verified via reference search).

**Files:**
- Modify: `sieve/ai/eval.go` (`detectContentType`, `extractJSONFallback` — package-level free funcs)
- Modify: `sieve/ai/ai_service.go` — the three sibling free funcs (`isHTMLBodyEmpty` @ called `:52`, `extractFirstHeading` @ called `:465`, `filingCommitDocument` @ called `:79`) plus the call sites for all five
- Modify/relocate: any `sieve/ai/eval_test.go` / `ai_service_test.go` (keep white-box in `ai`)

**Owning-type decision:** All five are AIService-private response/filing helpers (used nowhere else in the tree). Attach them as unexported methods on `*AIService`. No new type — the owner already exists. **Note for `filingCommitDocument`:** it currently takes `documents *services.DocumentService` as a parameter but the sole call site passes `s.documents` — as a method it reads `s.documents` directly, so drop that redundant parameter (verify `*AIService` has a `documents` field via the call site `filingCommitDocument(doc, s.documents, …)`).

**Interfaces:**
- Produces: `(*AIService).detectContentType(string) string`, `(*AIService).extractJSONFallback(string) string`, `(*AIService).isHTMLBodyEmpty(string) bool`, `(*AIService).extractFirstHeading(string) string`, `(*AIService).filingCommitDocument(n domain.Document, save bool, fileAfter bool) (FilingOutcome, error)`.

- [ ] **Step 1: Move all five funcs onto `*AIService`** as methods (keep them in their current files, just change the signature to add the receiver). Bodies unchanged except `filingCommitDocument` swaps its `documents` parameter for `s.documents`.

- [ ] **Step 2: Update every call site** in `ai_service.go` to the receiver form (use the actual receiver name in that file). For `filingCommitDocument`, drop the `s.documents` argument.

- [ ] **Step 3: Update any eval/ai_service test** to construct an `AIService` and call the methods, OR — if the tests are pure string-in/string-out — keep them but call through a minimal `AIService` value. Do not add a construction seam that exists only for the test. If `filingCommitDocument` has a test, it now needs an `AIService` whose `documents` field is populated — match the existing construction idiom in `ai` tests.

- [ ] **Step 4: Run the AI suite**

Run: `go test ./sieve/ai/...`
Expected: PASS.

- [ ] **Step 5: Full build**

Run: `go build ./...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/ai/
git commit -m "refactor(ai): own response/filing helpers on AIService, retire free funcs"
```

---

## Task 2b: Attach the `block/` codec/parser free funcs to their owning types (no-loose-functions, part 3)

> **Added 2026-06-29.** CLAUDE.md's Design Principles explicitly name this pocket as backlog: *"block/'s codec/parser still has free funcs … serialize/deserialize are `BlockProcessor`/`DocumentCodec` methods."* This task discharges it.

**Files:**
- Modify: `sieve/block/document_codec.go` (`serializeFencedBlock` — called `:118` + `processor_registry.go:306`)
- Modify: `sieve/block/markdown_parser.go` (`serializeInlineBlock` — called `processor_registry.go:316`; `FindBlockByID` — called `context_provider.go:85`)
- Modify: `sieve/block/shadow_snapshot.go` (`cloneBlockDeep` — called throughout that file)
- Modify: call sites listed above + any white-box tests touching these (stay in `block`)

**Owning-type decision (owners verified by call-site investigation 2026-06-29 — the plan's initial "all → DocumentCodec" guess was WRONG):**
- `serializeFencedBlock` → fold into **`FencedSerializer.Serialize`** (`processor_registry.go:304-307`). Its primary caller is that embedded value-type serializer, which has NO `DocumentCodec` in hand; its own doc comment says it is the FencedSerializer's "registry-free" logic. The codec fallback at `document_codec.go:118` becomes `return FencedSerializer{}.Serialize(b)`.
- `serializeInlineBlock` → fold into **`InlineSerializer.Serialize`** (`processor_registry.go:314-317`). Its own doc comment (`markdown_parser.go:16-17`) already states "It is owned by InlineSerializer."
- `FindBlockByID` → **`DocumentCodec` method** `(c *DocumentCodec) findBlockByID(markdown, id string) (SieveBlock, bool)`. It is genuinely a parse op — it currently self-constructs `NewDocumentCodec(GlobalRegistry())` internally. Move that construction to the sole caller `BuildContextForID` (`context_provider.go:85`): `NewDocumentCodec(GlobalRegistry()).findBlockByID(doc.deriveMarkdown(), id)`. (`BuildContextForID` is itself a loose func of the context-provider registry family — out of scope here; leave it a func, just have it build the codec.)
- `cloneBlockDeep` → **`SieveBlock` method** `(b SieveBlock) cloneDeep() SieveBlock` (pure value transform over a block's own data; mirrors `gcRefs`/`answersTo` from Task 1). Unambiguous, self-contained.

**Interfaces:**
- Produces: `FencedSerializer.Serialize` and `InlineSerializer.Serialize` absorb their helper bodies (no more free delegation); `(*DocumentCodec).findBlockByID(markdown, id string) (SieveBlock, bool)`; `(SieveBlock).cloneDeep() SieveBlock`. All four free funcs deleted.

- [ ] **Step 1: Do `cloneBlockDeep` first** (lowest risk) — make it `(b SieveBlock) cloneDeep() SieveBlock`, update all `shadow_snapshot.go` call sites. Run `go test ./sieve/block/...`.
- [ ] **Step 2: Fold the two serialize helpers** into `FencedSerializer.Serialize` / `InlineSerializer.Serialize` (move the body in, delete the free func). Update `document_codec.go:118` fallback to `FencedSerializer{}.Serialize(b)`.
- [ ] **Step 3: Methodize `FindBlockByID`** onto `DocumentCodec` as `findBlockByID` (drop the internal codec construction; the receiver IS the codec). Update `BuildContextForID` (`context_provider.go:85`) to construct the codec and call the method. Lower-case it (only in-package callers).
- [ ] **Step 4: Update white-box tests** that call these to use the new receivers; assertions unchanged. (Check for tests on `FindBlockByID` / `cloneBlockDeep` / the serializers.)
- [ ] **Step 5: Green + build + vet** — `go test ./sieve/block/...` and `go build ./... && go vet ./sieve/block/...`.
- [ ] **Step 6: Commit**

```bash
git add sieve/block/
git commit -m "refactor(block): own codec/parser helpers on DocumentCodec/SieveBlock, retire free funcs"
```

---

## Task 3: Clear test debt — C-T (stale) + T-A (flaky)

**Files:**
- Delete: `frontend/test/render-exact-shadow.test.js` (pins a retired step-5 schema with `sieve-prose`/`sieve-log` custom nodes that no longer exist — current model is native prose nodes + `proseGroup`; its concern is covered by current block-model tests)
- Defer (do NOT touch here): `frontend/test/proseidentity-loop.test.js` — it pins the **live** `editor.js` proseIdentity appendTransaction contract, which **B-A rewrites**. Reconcile it *inside* the B-A plan (Task 5), not pre-emptively.
- Modify: the flaky `TestHandleBlockUpdate_notifySendsSnapshotUnderLock` (`sieve/services/`) — teardown race: a watcher/async writer still touches the test's `buffers/` dir when `t.TempDir()` cleanup runs.

- [ ] **Step 1: Confirm `render-exact-shadow.test.js` is dead** — grep its asserted node names against the live schema.

Run: `grep -rn "sieve-prose\|sieve-log" frontend/src/static/`
Expected: no live definition of `sieve-prose`/`sieve-log` as PM nodes (confirms the test pins a retired schema).

- [ ] **Step 2: Delete it and run vitest**

```bash
git rm frontend/test/render-exact-shadow.test.js
cd frontend && npx vitest run
```
Expected: green, one fewer file.

- [ ] **Step 3: Read the flaky test** (`sieve/services/...`) and locate where it starts a watcher / spawns the async writer whose handle outlives the test.

- [ ] **Step 4: Drain before teardown** — stop the watcher and wait for in-flight async writes to quiesce before the test returns (e.g. `defer watcher.Close()` + a synchronisation point on the writer), OR switch to an explicitly-managed temp dir removed after quiescing instead of `t.TempDir()`. Match the existing teardown idiom in neighbouring `sieve/services` tests.

- [ ] **Step 5: Hammer the test for flakiness**

Run: `go test ./sieve/services/ -run TestHandleBlockUpdate_notifySendsSnapshotUnderLock -count=30 -race`
Expected: 30/30 PASS, no `TempDir RemoveAll cleanup: directory not empty`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: delete stale render-exact-shadow, fix flaky notifySendsSnapshotUnderLock teardown"
```

---

## Task 4: L-A — `renderBlocksIntoEditor` clears on a genuinely-empty reload

**Files:**
- Modify: `frontend/src/static/editor.js` (`renderBlocksIntoEditor` — early-returns `if (!nodes.length) return`, leaving stale content)
- Modify: the known-good reload callers that can legitimately empty a doc (`softReloadContent`, `editor:restore` paths)
- Test: `frontend/test/` (new vitest covering the clear-vs-keep branch on the pure node-mapping logic)

**Interfaces:**
- Consumes: existing `renderBlocksIntoEditor(blocks, opts)` signature.
- Produces: `renderBlocksIntoEditor` distinguishes "no blocks parsed (transient/error → keep existing)" from "document is genuinely empty (→ clear to one empty paragraph)" via an explicit caller intent flag (e.g. `opts.allowEmpty === true`).

- [ ] **Step 1: Write the failing test** — a genuinely-empty reload with `allowEmpty:true` clears to one empty paragraph; an empty list without the flag keeps existing content.

```js
it('clears to one empty paragraph when allowEmpty and blocks are empty', () => {
  const doc = renderBlocksToDoc([], { allowEmpty: true })   // pure mapper under test
  expect(doc.childCount).toBe(1)
  expect(doc.firstChild.type.name).toBe('paragraph')
  expect(doc.firstChild.childCount).toBe(0)
})

it('keeps existing content when blocks are empty without allowEmpty', () => {
  const kept = renderBlocksToDoc([], { allowEmpty: false })
  expect(kept).toBeNull()   // null = "keep", caller skips replace
})
```
(If `renderBlocksIntoEditor` is not unit-testable as-is, extract the empty-decision into a pure helper `renderBlocksToDoc(blocks, opts)` and test that — keep the editor-side wiring thin.)

- [ ] **Step 2: Run it — fails**

Run: `cd frontend && npx vitest run test/render-empty-reload.test.js`
Expected: FAIL (`allowEmpty` not honoured).

- [ ] **Step 3: Implement the branch** — `renderBlocksIntoEditor`: on empty `nodes`, if `opts.allowEmpty` replace with a single empty paragraph; else keep (current behaviour). Pass `allowEmpty:true` from the known-good reload callers only.

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 5: In-app verify** — in WebKitGTK (`[[project_test_perf_in_wails_app]]`), open a doc, delete all content, trigger a known-good reload (version restore to an empty version) → screen clears, not stale.

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "fix(editor): clear to empty paragraph on genuinely-empty reload (L-A)"
```

---

## Task 5 (meta): Write the B-A dedicated plan

**Deliverable:** `docs/superpowers/plans/2026-06-29-backend-authoritative-prose-id.md`, written via the writing-plans skill on its **own branch**, with strict TDD.

**Why its own plan:** B-A retires the frontend prose-id mint in the highest-churn area of the editor (two prior reverts). It needs investigation of the current `prose-block.js` mint plugin, `ws_handler.go`, and the debounced observer before any code — fabricating steps here would be guesswork.

- [ ] **Step 1: Investigate and record** the current mint flow: `mintProseId`/`mintActions` (`prose-block.js`), the `blockId` minting plugin, `HandleBlockOp` create path (already positioned, per TECH-DEBT B-A "Progress 2026-06-21"), and the `splitBlock` duplicate-id trap (`[[project_node_granular_prose]]`).
- [ ] **Step 2: Pin the design** from TECH-DEBT B-A "Retires when": `create-block` carries content + index + a transient correlation **token** (not a durable id), marks the node pending; `HandleBlockOp` mints the id; WS layer acks `{token → blockId}`; frontend applies the backend id and clears pending; observer skips pending nodes; `splitBlock` **clears** the copied id (reuse `mintActions` detection) rather than re-minting.
- [ ] **Step 3: Fold in `proseidentity-loop.test.js`** (deferred from Task 3) — rewrite it to the token→mint→ack contract or confirm it still holds.
- [ ] **Step 4: Write the plan** with bite-sized TDD tasks; note it also retires E-1's root principle (identity never invented on the frontend).
- [ ] **Step 5: Commit the plan doc.**

---

## Task 6 (meta): Write the F-A dedicated plan

**Deliverable:** `docs/superpowers/plans/2026-06-29-markdown-mode-seed-from-go.md`.

**Why its own plan:** F-A is narrower than its register entry (the structured-edit `doc-update` fallback was already retired by B-G). The remaining surface is "markdown-mode seeds its textarea from JS-serialized whole-doc markdown; seed it from Go's codec instead." It needs a quick scoping pass to confirm the exact remaining `wysiwygMarkdown`/`wrapProseBlock` call paths in `prose-group.js`/`prose-markers.js`/`prose-block.js`.

- [ ] **Step 1: Scope** — grep the three `prose-*.js` survivors; confirm `EnterMarkdown` (Go) already derives the markdown-mode buffer via the codec, so the JS seed is redundant.
- [ ] **Step 2: Update TECH-DEBT F-A** to the verified-narrow scope.
- [ ] **Step 3: Write the plan** (likely a handful of tasks: route markdown-mode entry through the Go-derived buffer; delete the JS whole-doc serialize seed; keep prose-block markdown serialize for prose round-trip).
- [ ] **Step 4: Commit the plan doc.**

---

## Task 7: S-A JS regroup — mirror the Go packages (do LAST)

**Files:**
- Move: the 31 flat `frontend/src/static/*.js` files into folders mirroring the 6 Go packages (`block/`, `processors/`, `services/`, `ai/`, plus an `editor/` core and a shared `base/`). Exact grouping decided at task start from the current file list.
- Modify: every `import`/`<script>` reference (`frontend/src/index.html`, `frontend/src/templates/*.html`, inter-module imports) to the new paths.

**Why last:** pure structure, zero behaviour change — done after Tasks 1–6 so the file moves don't create path conflicts with the behaviour work (especially B-A, which edits the prose/editor JS heavily).

- [ ] **Step 1: Draft the folder map** — list all 31 files, assign each to a group mirroring the Go DAG; record the map in the commit body. Defer affordance-file placement decisions to their content owner but move them by path (behaviour untouched — `[[project_editor_layout_affordances_redesign]]`).
- [ ] **Step 2: Move files + fix imports** group by group (one group per commit if large), updating every reference.
- [ ] **Step 3: Rebuild touch** — recall `wails dev` only rebuilds on `.go` changes; `/static/` is live from disk, but `index.html`/embed changes need a `.go` touch (`[[project_wails_dev_rebuild_gotcha]]`).
- [ ] **Step 4: Full test + in-app smoke**

Run: `cd frontend && npx vitest run` and `go build ./...`; then load the app in WebKitGTK and confirm the editor mounts, blocks render, AI/paste flows work.
Expected: green; app loads with no missing-module console errors.

- [ ] **Step 5: Commit** (per group).

```bash
git add -A
git commit -m "refactor(js): regroup static/ to mirror Go packages (S-A JS half)"
```

- [ ] **Step 6: Retire S-A in TECH-DEBT** — mark the JS half done; the no-loose-functions Go backlog (Tasks 1–2) and S-A JS regroup were its remaining open items.

---

## Self-Review

**Spec coverage (against TECH-DEBT close-out scope, UI excluded):**
- no-loose-functions (CLAUDE.md / S-A item 3) → Tasks 1, 2, 2b ✓ for the **named pockets** (handle_gc, AIService-private helpers, block/ codec/parser). **NOT a complete sweep** — per-processor private helpers (prose/code/log/smart-image), `block/ai_context` helpers, and the domain/services/root DTO+parse helpers remain loose. CLAUDE.md frames this as opportunistic ("attach as opportunity allows"); the remaining surface is tracked as ongoing TECH-DEBT, not claimed done here.
- C-T stale tests → Task 3 (render-exact-shadow now; proseidentity-loop deferred into B-A) ✓
- T-A flaky test → Task 3 ✓
- L-A empty-reload → Task 4 ✓
- B-A prose-id mint → Task 5 (dedicated plan) ✓
- F-A markdown-mode seed → Task 6 (dedicated plan) ✓
- S-A JS regroup → Task 7 ✓
- Affordances / B-D / indigo rail / lineage / doc-map / columns → **out of scope, U-A** ✓ (intentional, not a gap)
- D-L (parked), P-A (separate feature), C-W (already retired) → correctly not included.

**Placeholder scan:** Tasks 1–4, 7 carry real code/commands. Tasks 5–6 are *meta-tasks* that produce dedicated plans (sanctioned scope-split), not fabricated implementation — their steps are investigation+authoring actions, not placeholder TODOs.

**Type consistency:** `(*ShadowDocument).collectHandles/gcAliases` + `(SieveBlock).gcRefs` (Task 1) used consistently; `(*AIService).detectContentType/extractJSONFallback` (Task 2) match the call sites named; `renderBlocksToDoc(blocks, opts)` + `opts.allowEmpty` (Task 4) consistent across test and impl.

**Owning-type decisions:** Task 1 settled (2026-06-29) — GC is the ShadowDocument's internal job, methods on `ShadowDocument`/`SieveBlock`, no separate service. Task 2 — methods on the existing `*AIService` owner.
