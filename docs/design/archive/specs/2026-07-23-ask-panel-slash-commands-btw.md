> **STATUS: DONE** — shipped 2026-07-26 on `feat/ask-panel-slash-commands-btw` (36 commits): command registry + session channel + /btw + CommandService/badges/popup per spec, plus in-branch evolution — honest `command-result` kind (title/response/primary), Family()/ResultKind() metadata with integrity-checked gate, dispatcher-stamped correlation identity, requester-affine result routing, component .styles.js carriage. Full code review + live-app validation in-branch. Decision #5 (jobs-cell filter) REVERSED on live review — command jobs paint uniformly; badge is additive. Archived 2026-07-26.

# Ask Panel Slash Commands & `/btw`

*2026-07-23 · Tracked: #55*

## Problem

While writing a document the user often needs a throwaway answer — "what does
SRP stand for again?" — without breaking flow. Today every ask creates an
ai-block in the document (a deliberate invariant), so a quick reminder either
pollutes the doc or the user context-switches out of Sieve entirely.

Rejected shapes, in order:

- **A meta-panel Q&A tab** — two always-available AI inputs with no obvious
  division of labour ("how would the user know what to do"). Add a *verb* to
  the existing input, not a surface: Claude Code's `/btw` gesture.
- **A JS-side command registry + blocking `POST /api/ai/quick-ask`** — wrong
  twice. A 20–60s CLI call behind a blocking request has no cancel, no
  progress, and fragile timeouts. And doc-mutating commands (`/diagram
  <prompt>` is the motivating future) must be standard block operations —
  a JS registry with bespoke endpoints would grow into a second async flow
  beside the block-op/job machinery, the exact asymmetry the PlantUML spec
  just removed.

## Decision

**The Ask panel becomes a command line over a Go-owned command framework.**
Input starting with `/` is parsed by the panel and dispatched as an
`AICommand` over the existing WS wire; everything else behaves exactly as
today (the ask-makes-an-ai-block invariant is untouched).

**AI commands are jobs that produce blocks; the tool decides where they
land.**

- Every command runs through the standard job machinery (queue, worker pools,
  timeout policy, cancellation, status lifecycle).
- Every command's result **is a block** — there is no separate "ephemeral
  result payload" type. The `AsyncAICommand` / `BlockCommand` fork dissolves
  into one envelope; where the block lands is **the command's decision**
  (policy in the tool, never wire metadata):
  - **additive** — the handler creates the block in the ShadowDoc (anchor
    derived from the sent context) and it arrives via the standard tracked
    insert-block render-back (`/diagram`, later). The dispatcher never
    witnesses the effect.
  - **standalone** — the block never joins a document; its envelope
    (kind + attrs) returns correlated over the same WS and lives only in the
    requesting surface (`/btw`).
- A `/btw` answer is therefore an **ai-block without a home**: question +
  response + status is literally the ai-block shape. The popup renders it
  with the existing PM-free `AiBlockRenderer` — the third host of
  "one renderer, three hosts" (note lens / chat lens / cards), and the first
  breath of the brainstorm-5 chat lens, whose chat is a *list of detached
  turns*.

v1 ships: the Go registry, the wire protocol, `/btw` (detached), and
discoverability. `/diagram` et al. are later registry entries (additive
handlers), not new plumbing.

## Architecture

### Wire protocol (session channel, new message family)

```
Command       { family: "ai", cmd, args: { text },
                correlationId, context: SelectionContext }
CommandResult { correlationId, cmd, status: PENDING|COMPLETE|ERROR,
                block?: { kind, attrs },   // detached result → popup lens
                error? }
```

- **Mechanism on the wire, policy in the tool.** The envelope carries what
  the frontend actually has — verb, raw args, and the panel's last-rendered
  `SelectionContext` verbatim (the D-5 send==shown object: full selection
  breakdown, block target id/index, refs, …).
- **The wire does not own the context's schema.** Each editor lens authors
  its own SelectionContext shape; the envelope ferries it; the tool
  interprets it as it sees fit (editor authors → wire ferries → tool
  interprets). The Go-side parse shape is **deliberately unresolved until
  build time** — plausibly a typed core (doc uuid, selection, block target)
  plus an editor-specific bag for the rest; fully-opaque and fully-rigid are
  both wrong. Whatever lands, the invariants hold: commands read fields
  *opportunistically, never requiring them*; the floor is the empty context
  (`/btw` with no tab must work); future lenses (workbench, chat) can ship
  richer contexts without touching any existing command. What happens
  next is the command's decision, never the protocol's: an *additive*
  command's job terminates in the **same internal mutation path
  paste/transform/extract already call** (ShadowDoc insert → tracked
  render-back on the doc channel — the editor cannot tell an AI-authored
  insert from a paste, and the dispatcher never witnesses the effect); a
  *standalone* command uses the context purely as prompt grounding + MCP
  scope. There is no `sink` field anywhere — outcome shape is command
  behaviour, not wire metadata. One generic result rule: a `CommandResult`
  carrying a block envelope is rendered detached (the popup lens — any
  future standalone command gets it free); no block → effects, if any,
  already arrived through normal channels. Go deriving the anchor from
  `context` is the createBlock contract's long-noted "future Go-resolves
  protocol move", arriving naturally.
- **The envelope is generic; AI commands are its first tenant.** The
  `family` field exists from day one so future workspace protocol families
  (the load/save/raw-content family, export-source) can join the same wire
  without a rename. See "Direction unlocked" below.

- **Commands are workspace-scoped, not document-scoped** — a `/btw` needs no
  document at all ("what's the weather"); the sent `SelectionContext` is
  *granted context*, never addressing. Dispatch and standalone results
  therefore ride a **session-level channel** (a reserved workspace channel
  beside the per-uuid doc channels, owned by the command peer) whose
  lifetime is the app session, not any document — closing a tab cannot
  orphan an in-flight `/btw`. Additive commands dispatch on the session
  channel too, but their **effects** arrive where block traffic already
  lives: ordinary tracked render-backs on the target doc's channel. The
  tool decides where effects land; the envelope is always session traffic.
- Correlation follows the block-op opId ack pattern already on the wire.
- Anchors are **block ids, never indexes** (the established createBlock
  contract), derived by Go from the sent context; Go resolves position.
- **No parallel mutation vocabulary — the uniformity lives inside Go.** An
  additive command's handler ends by calling the same internal op path
  (create-block on the ShadowDoc, anchor derived from `context`) that
  paste/transform/extract call; the wire never carries op-shaped args.
  `/diagram <prompt>` is: AI turns the prompt into diagram attrs (`source`,
  type), then the plain internal create-block. What a command changes is
  *who authored the attrs* and *how the request arrived*; the op is the
  same one the existing paths already speak.
- Standalone lifecycle transitions (PENDING → COMPLETE/ERROR) flow as
  correlated results. PENDING paints in the **status bar's existing
  active-job badge surface** — /btw pending lives where every other AI
  job's pending already lives; nothing blocks or covers the document. The
  popup renders the block's **current state whenever summoned** (clicking a
  pending badge opts into a spinner popup that becomes the answer in
  place); it is *auto*-summoned only by a terminal result.

### Go

- **`AICommandRegistry`** — one typed declaration per command:
  `{ name, description, BuildJob(args, context) }` (no sink field — outcome
  shape is the handler's behaviour). Registered at the composition root; the
  WS handler routes `Command` → registry → job queue.
  Standard `JobTracker` lifecycle; worker-pool category for commands; per-
  command timeout via `PromptTimeouts` (fallback `CLITimeoutLong`).
- **Discoverability is registry-driven, enumerated at boot**: the registry
  is Go code and changes only with the binary, so the command list
  (name + one-liner) ships as workspace boot state — the hint popover renders
  with zero first-keystroke latency, and a new command is a Go-only change.
- **The `/btw` command**: builds a detached ai-block through the normal
  processor shape and runs the CLI via `RunCLI` with:
  - **A new `btw.md` prompt** — the ask prompt is written for
    thread/document-inserted answers; wrong instructions, wrong grounding.
    `btw.md` is first-class beside ask/explain (user-editable prompt tab, own
    `PromptTimeouts` entry). Stance: answer concisely and directly; document
    context is ambient background for disambiguation only — don't analyze the
    doc, don't suggest edits, don't mention it unless the question requires
    it. Born compatible with the #42 (SEC-A) Go-owned role-template
    direction.
  - **Context: push a pointer, let the model pull.** Pushed: `{{question}}`;
    `{{selection}}` (highlighted text verbatim, if any); `{{doc_title}}` +
    `{{doc_summary}}` + `{{doc_uuid}}` (from `.meta` — the quick-ask path
    touches only meta, never the ShadowDoc). The prompt authorizes calling
    the Sieve MCP's `get_note(uuid)` when the document's actual content is
    genuinely needed, preferring direct answers otherwise. The MCP endpoint +
    bearer token already rides into every contained CLI call
    (`ai.MCPEndpoint` seam); `get_note`'s `LoadByUUID` resolves **buffers as
    well as notes**, so the primary scenario (unfiled scratch) works.
  - **This is the brainstorm-5 fence-crossing, made consciously**: the first
    role that pulls context instead of receiving a curated bundle. /btw is
    the right first crossing — read-only verbs, every `get_note` body read
    audit-logged at one boundary, output confined to a popup: worst case is a
    worse answer, never a touched document.
  - Accepted staleness: the pull reads disk truth, which may lag the editor
    by the autosave debounce; no flush-save for a throwaway gesture.
    `LoadByUUID` is O(n) — the bridge-op it was documented for; the #37
    index eventually makes it cheap.
  - **Excluded from context:** refs chain, thread history — the doc is
    background, not subject.
  - Tier gating: TierDumb (no CLI) → ERROR result, popup says so — same
    degradation story as every AI feature.

### Frontend

- **A thin command protocol peer** beside `block-service.js` /
  `document-service.js` (the #49 rule: surfaces are transport-blind). It owns
  the `Command`/`CommandResult` family, correlation, and the registry
  enumeration; the Ask panel and popup never touch the wire.
- `shell/ask-panel.js` — the panel stays dumb and stateless; **parsing picks
  the door**. Leading `/` + registered command → dispatch to the command
  peer with the raw arg text + the panel's `SelectionContext` verbatim (no
  per-command knowledge in the dispatcher; the tool decides what the context
  means), and the Send affordance visibly flips (e.g. "Run /btw") — the cue
  that the input is now a command line, not a question. Slash + unknown → inline error
  hint; **not** dispatched anywhere. No slash → `editor.askAi`, byte-for-byte
  as today. Two doors, no new panel state. (Horizon note, explicitly not v1:
  plain ask is conceptually the *default attached command*; the registry may
  absorb it one day. The ask path is untouched here.)
- Discoverability: typing `/` at position 0 shows a hint popover listing the
  Go-enumerated commands (name + one-liner), prefix-filtered. Read-only hint
  in v1 — no fuzzy matching, no keyboard selection.
- **Badge → popup lifecycle** (`shell/` sibling module): on dispatch the
  input clears and the /btw job appears as a **status-bar active-job badge**
  (the same surface other AI jobs use — spinner going, nothing near the
  document, the user keeps typing). **One badge per correlated job**
  (badge ↔ correlationId, 1:1): concurrent /btws each get their own badge
  with an independent lifecycle — spinner while pending, lit while holding
  its answer, gone when dismissed. (This retires the earlier
  "new `/btw` replaces the held answer" rule — an artifact of the
  single-badge model.) **Click toggles the badge's popup at any time**:
  clicked while pending, the popup shows the renderer's job chrome and
  becomes the answer in place when the result lands (the opt-in spinner);
  on a terminal result the popup auto-emerges. Rendering via
  **`AiBlockRenderer`** (COMPLETE = sanctioned-markdown answer; ERROR = the
  renderer's error state) — never stealing keyboard focus: an appearance,
  not an interruption. Scrollable, text-selectable, copy button. The popup
  carries **two distinct exit verbs**:
  - **Hide** (Esc, click-away, minimize-style button): popup disappears,
    the badge stays lit — the answer is parked in the status bar,
    re-openable by click.
  - **Delete** (✕/trash, visually distinct from Hide): the held answer is
    discarded and the badge goes with it — gone for good. On a *pending*
    popup/badge, Delete **cancels the job** via the standard job-engine
    cancellation path — one verb ("remove from existence") in both states.
  App restart forgets everything. When badges would multiply beyond taste,
  that is the Job Engine Viewer's cue (extension doc).

## Rationale

- **One AI input with verbs** beats two AI surfaces: no daily "which box do I
  type in" tax, and the gesture is pre-learned from Claude Code et al.
- **Commands tie into the normal framework** because later commands *are*
  standard block operations: an additive command's handler calls the same
  internal create-block path the block machinery already speaks — only the
  arrival route (and the attrs' author: the AI) is new. `/diagram` =
  that internal insert + the diagram block's own render job, zero new
  mechanism. Building /btw on bespoke HTTP would have made the second
  command a rewrite instead of a registry entry.
- **"Jobs that produce blocks; the tool decides where they land"** is the
  uniform mechanism the two-type split was groping toward: every command is
  a job producing a block; only delivery differs, and delivery is command
  behaviour, not protocol. It also makes "insert into doc" a non-feature (a detached block
  promoted to the document is a standard insert at an anchor — it was always
  a block; it just gets a home) and turns the future chat kind into "a list
  of detached turns" rather than a leap.
- **Go-owned registry**: backend is the source of truth for what commands
  exist; JS renders what Go declares, and discoverability can never drift
  from capability.

## Direction unlocked (deliberately NOT this spec)

> Full direction documents: `../extension-workspace-command-plane.md` and
> `../extension-job-engine-viewer.md` — this section is the summary of
> record; the extension docs carry the complete reasoning.

The session command channel is the seed of a **workspace command plane**:
once a correlated command envelope exists at session scope, the
`document-service.js` HTTP families (load/save/raw-content, export-source)
are protocol traffic wearing request clothing — they migrate to commands on
the same wire, a JS `WorkspaceService` becomes the wire owner beside
`block-service`, and the editor request handlers retire family by family.
The boundary that holds: **protocol vs hypermedia** — JSON app-operations
move to the wire; HTMX fragments, `/static`, assets, index, and SSE-triggered
swaps stay HTTP (that is HTMX's architecture, not debt). Known wins there:
save + block ops on one ordered pipe kills a class of transport races (the
SnapshotForJob coherence guard's cousins). Known costs: reconnect/replay
semantics for correlated commands, and the session channel needs the doc
channels' ownership guard (the 6e2ccfc lesson).

The plane also completes **TECH-DEBT V-B** (tabs as self-rendering objects,
not HTMX templates): the Workspace is the representation of the Session, so
tab open/close/reorder/load become session *mutations* — commands whose
reflected state returns as a **session render-back** the Workspace
reconciles into `SieveTab` children. Same pattern as blocks, one scale up
(op → Go truth → render-back → painter); `session:changed` for the
workspace becomes an unsolicited session render-back on the wire (watcher
pushes ride the same path). The boundary: **below the Workspace everything
is an object** (session/tabs/editors/blocks/jobs — V-B's divergence worry
dissolves into whole-subtree convergence); HTMX survives beside the
workspace (peripheral library views: sidebar/meta/prompts), not below it.

Second unlock — **the Job Engine Viewer, the home for jobs**. Today a job's
only UI is its render-back target (its block); homeless jobs were
impossible until commands created correlated jobs with no block. The /btw
badge generalizes: click → a centered summonable list (the quick-switcher
paradigm) over the **JobTracker's full truth** — every job, block-backed or
correlated, active/pending/held; each row links to its home (scroll-to-
block, or re-open the popup for UI-persistent command results). Retention
is **structural, not a flag**: transient jobs (filing, explain, renders)
leave the viewer on completion because their render-back home holds the
result; homeless correlated jobs (/btw) stick — the viewer IS their home.
The viewer aggregates, never replaces block chrome; it is where cancel/
retry/grouped-by-category affordances finally get a home. Completes the summonable
triad: Ctrl+P = nouns (documents), command palette = verbs (commands, the
plane's lens), job viewer = processes (running work). v1 here ships only
the single-answer badge, which later becomes the viewer's summon point.

Own epic(s), own spec(s); this spec only requires that the envelope not
preclude them (the `family` field; correlated jobs registered in the
JobTracker like every other job).

## Out of scope (follow-ups)

- `/diagram <prompt>` and other additive commands (registry entries).
- Promote-to-doc button on the popup (standard insert; near-free once wanted).
- Fuzzy autocomplete / keyboard-navigable command palette. (Straw-manned
  2026-07-23: a Ctrl+Shift+Space centered palette is a *second dispatcher*
  over the same registry/envelope — palettes select verbs, composers compose
  payloads, and /btw is payload-shaped. The palette's moment is when the
  workspace command plane fills the verb inventory; it is that epic's lens,
  purely additive here.)
- Any Q&A history or persistence (the chat document kind, brainstorm 5).
