# Containment fix: typed tool grants + cwd never unset

**Status:** PROPOSED
**Tracked:** #41 — follow-up to #36 (AI CLI containment).
**Date:** 2026-07-17
**Supersedes for the tool plane:** the flat `[]ToolGrant{Name}` model in `../archive/specs/2026-07-16-ai-cli-containment-and-sieve-mcp-design.md`.

## Problem

The shipped containment profile (#36) leaks reads across the whole filesystem, and
its tool model bakes one CLI's vocabulary into the CLI-neutral domain. Two concrete
defects, both confirmed by live `claude` CLI runs (2.1.207) on 2026-07-17:

1. **Bare tool names in `--allowedTools` are path-UNSCOPED permission rules.**
   `claudeBackend.buildArgs` renders the baseline as `--allowedTools Read,Grep,Glob,WebFetch`.
   In Claude Code's rule grammar a bare `Read` matches *every* invocation, so it
   **auto-approves reads at any path** — defeating the native workspace gate that
   dropping `--dangerously-skip-permissions` was supposed to re-arm. Proven:
   - outside-workspace read **succeeds** with the flag; `READ-DENIED` without it;
   - in-cwd read **succeeds with no allowlist at all** (the workspace already
     permits reads inside cwd + `--add-dir`).
   So the bare `Read/Grep/Glob` grants do **nothing** for legitimate note/library
   work — their only effect is unlocking the rest of the disk. `Write` behaves
   identically (a bare `Write` allow wrote a file well outside the workspace).

2. **Two frequent ops spawn the subprocess with `cwd=""`.** `RefineLanguage`
   (`ai_service.go:253`) and the filing evaluation (`ai_service.go:379`) inherit
   the app's process cwd, which on a Finder/Dock-launched macOS app is `/`. For
   those ops the workspace is the entire disk even with the native gate armed.

**Observed symptom:** macOS TCC dialogs for `~/Downloads` and `~/Pictures` — the
model "looking around" descends into `$HOME` via a globally-approved Grep/Glob,
and TCC attributes the access to the responsible app (Sieve).

3. **The tool vocabulary is CLI-specific but stored as CLI-neutral.**
   `Read/Grep/Glob/WebFetch/Write/Edit` are Claude Code's names; `copilot` uses a
   different set (see the existing `--deny-tool shell,write`), and `agy` has no
   per-tool interface at all. `DefaultContainmentProfile` puts claude's strings in
   the domain and feeds them to every backend — it works only by coincidence
   (copilot copied several names) and is not a contract.

## Decision

### Containment model (the "how do we know a tool's semantics" answer)

Never infer a tool's semantics from its name. Make the semantics **declared** and
render per-backend. Every tool grant is one uniform shape:

- **`type`** — `file | network | other` — decides *scoping*.
- **`names`** — `map[cli]string` — decides the *emitted string* per backend.

Scoping by type (rendered by each backend adapter in its own dialect):

- **file** → auto-scoped to the profile's directory grants: the cross-product
  `verb(//<library>/**)`, `verb(//<note-dir>/**)`, `verb(//<user-dir>/**)`.
  The user never types a path. For read tools these scoped rules are
  redundant-but-harmless (the workspace already permits reads and a scoped rule
  can't widen anything); for write tools they are the load-bearing grant. Note-dir
  resolves per-invocation, so file rules render inside `Run`/`buildArgs` where cwd
  is known.
- **network** → scoped to user-supplied domains (`verb(domain:…)`). Empty ⇒ bare,
  labelled "unrestricted" in the panel.
- **other** → user-supplied specifier passed **verbatim**; empty ⇒ bare,
  labelled "not confined by Sieve".

Baseline vs user-added is **not** a subtype — same shape, different name table.
Baseline grants are displayed as **generic capability verbs**, CLI-neutral; the
per-CLI name table maps each to that CLI's actual tool name. The table value is a
**single string** (no lists) — where a CLI concept needs two distinct tools we seed
**two baseline grants**, not one grant that fans out:

- baseline `Read`   = `{type:file,    names:{claude:"Read",     copilot:"view"}}`
- baseline `Search` = `{type:file,    names:{claude:"Grep",     copilot:"grep"}}`
- baseline `Search` = `{type:file,    names:{claude:"Glob",     copilot:"glob"}}`  ← the second search grant, not a list
- baseline `Fetch`  = `{type:network, names:{claude:"WebFetch", copilot:"<url-flag>"}}`  ← copilot fetch is a URL-axis flag, not a tool name (see below)
- user-added        = `{type:file|network|other, names:{<activeCLI>:<verb>}}` (one-entry
  table, because a user names a tool while using one specific CLI)

All baseline entries are seeded in code and UI-locked; the UI shows the generic
verb, never the CLI-specific name.

**Uniform render path:** look up the active CLI in `names` → present ⇒ emit
(scoped per `type`) → **absent ⇒ omit the grant (fail closed)**. This is exactly
what "agy has no tool flag" resolves to: agy's column is empty for every
capability, so it emits no tool names and relies on `--add-dir` + `--mode plan` —
today's agy behaviour, now falling out of the general rule. A backend that cannot
express a type drops the grant; it never guesses a bare name.

### Baseline consequence

The claude/copilot backends **stop emitting bare `Read/Grep/Glob`**. Reads are
already contained by the workspace; the only allowlist entries that carry weight
are the ones the workspace can't cover — **network** (WebFetch/WebSearch) and
**MCP** (`mcp__sieve__*`). **Decision:** the `ContainmentProfile` **keeps** the
read/search capabilities as visible, UI-locked baseline grants — shown as the
generic verbs `Read` / `Search` (honest "the AI may read/search" UI) — but the
renderer, seeing `type:file`, scopes them to the directories rather than emitting
bare names. So they stay in the UI as capabilities and stop leaking as bare
allowlist entries; the two concerns are decoupled.

### cwd never unset

**Standing order: cwd is the note/buffer path.** If there is none — not sure how
that could be possible for an AI op that operates on a note/buffer — the defensive
position is the **library** root. cwd is never unset and never inherits the process
cwd (which on a Finder/Dock-launched macOS app is `/`).

Concretely: `RefineLanguage` and the filing evaluation fall back to `s.storePath`
(library root) when there is no note context, and `execCLIRunner.Run` treats
`cwd==""` as a bug — flooring it to the library rather than inheriting `/`. The
library floor is defence-in-depth: even if a caller forgets the fallback, the
runner never lets the subprocess land at the filesystem root.

### Add-tool form (mirrors the add-MCP-server form)

Three fields: **verb** (the tool name → goes into `names[activeCLI]`), **type**
(dropdown file/network/other → drives scoping), **constraint** (the specifier
line). The dropdown drives whether the constraint field is an input or a display:

- **file** → constraint is **read-only** with a generic placeholder, e.g.
  `Scoped to your granted directories (above)`. Real estate is tight and the
  directory grants are already listed directly above the add-tool form, so the
  field does **not** re-list paths — it just states that this tool inherits those
  grants. No literal paths, no glob syntax (both would lie: "current note" and the
  library resolve dynamically per-invocation/per-install).
- **network** → constraint is a user-supplied domain list.
- **other** → constraint is user-supplied and passed verbatim.

A user-added named tool follows the **active CLI**; if the user later switches CLI
the grant simply doesn't resolve and is omitted (no silent misfire). Worth a panel
note that named tools are CLI-specific and that a bare/other grant is unconfined.

### Panel layout (AI Access + settings modal)

Two layout changes, solving different problems (room vs. organization):

- **Settings modal sizing.** Today `settings.html` is `height: 75vh` with an
  implicit width. Grow it to **`width: min(90vw, 1200px); height: 90vh`**. Height
  at 90% is pure gain; width is capped so text inputs and help copy don't stretch
  to uncomfortable line lengths on a wide monitor (a flat 90% width sprawls). The
  existing left sidebar (top-level tabs: AI Provider / AI Access / Appearance /
  Editor / Logs) is unchanged.

- **Nested horizontal sub-tabs inside AI Access.** The pane currently stacks
  Tools → Directories → MCP Servers in one scroll. The typed-tool redesign makes
  the Tools rows taller (type dropdown + constraint field) and MCP rows are already
  the tallest content, so even at 90% height the third section needs scroll-hunting.
  Split the three into a **horizontal tab strip at the top of the AI Access pane**
  (Directories / Tools / MCP Servers), each getting full pane height. This also
  mirrors the model: three parallel *kinds* of grant, one uniform mechanism — the
  UI reflects the parallelism a vertical stack hides.

  Deliberately **not** promoting Directories/Tools/MCP to top-level sidebar entries:
  that would scatter one containment profile across the top-level nav and hide that
  they're a single profile. The second tab tier stays nested under AI Access — the
  nesting is justified precisely because the three belong together.

## Architecture / touch points

- `sieve/domain/containment.go` — `ToolGrant` grows `Type string`, a generic
  capability label (the UI verb: `Read`/`Search`/`Fetch`), and
  `Names map[string]string` (per-CLI tool name, single-valued).
  `DefaultContainmentProfile` seeds the generic baselines — two `Search` grants
  (claude `Grep` + `Glob`), one `Read`, one `Fetch`.
  `WithoutBaseline`/`LoadContainmentProfile` dedup keys move from tool name to the
  (label + per-CLI name) identity so the two `Search` grants stay distinct.
- `sieve/ai/cli.go` — each backend's `buildArgs` renders tool grants via the
  uniform lookup; `buildArgs` gains cwd (for per-invocation file scoping). Drop
  bare read-tool emission. Delete the now-wrong comment at `cli.go:156` claiming
  reads confine to cwd+add-dir under the current args.
- `sieve/ai/ai_service.go` — cwd fallbacks at lines 253, 379 (and audit 230, 539).
- `requesthandlers/settings_handler.go` — parse `containment_tool_type` +
  `containment_tool_constraint` alongside `containment_tool_name`.
- `frontend/src/templates/settings.html` — add-tool form gains type dropdown +
  type-driven constraint field; modal sizing → `min(90vw,1200px) × 90vh`; AI Access
  pane gains a nested horizontal sub-tab strip (Directories / Tools / MCP Servers)
  with its own tab-switch JS mirroring the existing `switchSettingsTab`.
- **No persistence migration.** Sieve has a single user (the maintainer) who can
  hand-recover settings.json; there are no legacy user-added `ToolGrant{Name}`
  additions worth migrating. The new typed shape is simply the format going
  forward — no back-compat code for the untyped form.

## Rendering contract (per backend)

| type    | claude                         | copilot                                                   | agy            |
|---------|--------------------------------|-----------------------------------------------------------|----------------|
| file    | `verb(//<dir>/**)` × dirs      | `--allow-tool view,grep,glob` (path-gated by `--add-dir`) | omit (dirs only)|
| network | `verb(domain:…)` / bare        | `--allow-url <domain>` / `--allow-all-urls` (URL axis)    | omit           |
| other   | verbatim specifier             | `--allow-tool <verbatim>`                                 | omit           |

Claude scopes file grants *in the allow rule* (`verb(//dir/**)`) because it has no
separate path gate; copilot scopes them *on the path axis* (`--add-dir`) and so
emits plain tool names. Same containment, different mechanism — rendered per
backend, not forced into one shape.

**Copilot has THREE orthogonal containment axes** (from `docs/copilot-cli-args.md`),
structurally different from claude, which simplifies file scoping:

1. **Paths** — `--add-dir=PATH` grants a directory; **file path verification is ON
   by default** (`--allow-all-paths` is the escape hatch that *disables* it). File
   access is confined to cwd + `--add-dir` regardless of which tools are allowed.
2. **URLs** — `--allow-url` / `--deny-url` / `--allow-all-urls` govern web access on
   their **own axis**. Web fetch is NOT an `--allow-tool` entry.
3. **Tools** — `--allow-tool` / `--deny-tool` grant/deny *permission to run a tool
   without prompting*; `--available-tools` / `--excluded-tools` govern visibility.
   Programmatic (`-p`) mode needs tools pre-approved (no TTY to confirm).

**Key asymmetry:** on claude a bare `Read` allow is filesystem-wide (no separate
path gate), so claude needs `Read(//path/**)` scoping. On copilot the path axis is
orthogonal — `--allow-tool view` grants permission to read, but `--add-dir` still
confines *where* — so copilot read/search tools need no path-scoped rule; the
directory grants do that. Copilot CLI tool names (not claude's): `view` (read),
`grep`, `glob` (search), `edit`/`write` (modify), `shell`.

**NEVER pass** `--allow-all`, `--yolo`, `--allow-all-paths`, `--allow-all-urls`, or
`--allow-all-tools` — the copilot equivalents of `--dangerously-skip-permissions`;
they defeat every axis. Keep the existing hard blocks (`--deny-tool shell,write`
unless the user opts in; `--disallow-temp-dir`). This corrects today's backend,
which emits bare `--allow-tool Read,Grep,Glob` (claude's names) and routes fetch
through the tool axis. agy stays directories-only.

## Verification owed before build

- Exact claude absolute-path rule syntax (`verb(//path/**)`) — the corrected-syntax
  write test did not complete; a malformed scoped rule was observed to **fail
  closed** (denied, nothing written), so a syntax error breaks the feature, not
  containment. Confirm the working form with one live run.
- Copilot (not installed on the dev box; args doc = `docs/copilot-cli-args.md`):
  confirm that `--allow-tool view,grep,glob` is required in `-p` mode for reads (vs
  auto-allowed within `--add-dir`), and that `--allow-tool` binds those literal tool
  names rather than coarse `shell(...)` kinds (issue #1482 ambiguity). Path axis
  (`--add-dir` + default verification) and URL axis (`--allow-url`) are
  **doc-confirmed** — no longer open.

## Rationale

- **Declared type, not inferred name** mirrors `McpGrant.Transport` and satisfies
  the project's "one uniform mechanism, no name-classification" rule — it's the
  same lesson as deleting the guessed `writes=/exec=` verdict (bf10067).
- **Capability + per-CLI name table** keeps the domain CLI-neutral while backends
  own their dialect, where per-CLI knowledge already lives.
- **Fail-closed omission** makes "a CLI can't express this" safe by construction.
- **Reads free via the workspace** means the allowlist shrinks to what it's
  genuinely for (network, MCP, opt-in scoped writes) — smaller attack surface,
  truer AI Access panel.
