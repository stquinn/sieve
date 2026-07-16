> **✅ DONE — #36 closed 2026-07-16.** Phases 1–3 shipped: containment floor
> (`ContainmentProfile`→per-backend args, skip-permissions removed), the internal
> read-only Sieve MCP (`/mcp`, token-authed, verbs `search`/`get_meta`/`get_note`/
> `list_facets`, inline `--mcp-config` injection for claude/copilot), profile
> persistence (baseline-in-code / additions-in-file), and the "AI Access" settings
> panel. Commits `d120d12`, `d5da4a4`, `e5dc315`. **Phase 4** (agy metadata/MCP
> layer via a startup-written `mcp_config.json`) is deferred — optional, agy
> library access already works via `--add-dir`. Search is an O(n) full-load
> stopgap until #37's materialized index lands. This spec is archived history.

# AI CLI Containment + the internal Sieve MCP — a user-governed capability profile rendered to CLI args

**Status:** IMPLEMENTED (Phases 1–3, 2026-07-16); Phase 4 deferred
**Tracked:** #36 (constrain the CLI) — CLOSED. Enables #37 (metadata views share the materialized index the MCP reads).
**Date:** 2026-07-16
**Companion:** `../brainstorm-blocks-all-the-way-up.md` §7 (the MCP is the "right tools" seam for AI-generated blocks and cross-app use).

## Problem

`sieve/ai/cli.go` `buildBaseArgs` runs every backend with permissions fully bypassed:

- claude: `--print --no-session-persistence --dangerously-skip-permissions`
- agy: `--dangerously-skip-permissions … --print`
- copilot: `--prompt "" --yolo --silent`

So each AI call has unrestricted Bash/Write/Read over everything the user can touch, cwd at the note dir. Sieve ingests **untrusted** content by design (web clips, paste); a note carrying injected instructions is fed via stdin to a shell-capable CLI — a prompt-injection RCE/exfil path. The only restraint today is a sentence in the prompt, which is not containment. Observed symptom: the CLI wanders the user's home directory (visible via macOS TCC prompts).

Two goals in tension, to be reconciled — not "lock down" vs "capable", but **make dangerous capability a visible, user-governed choice while everything else is contained by default.**

## Decision

**Two planes.**

1. **Capability plane — the internal Sieve MCP (HTTP, served by the running app).** Exposes the knowledge base as read-only tools over the materialized metadata index (#37): `search`, `get_meta`, `get_note`, `list_facets`. Injected into each CLI call inline; the CLI trusts it because Sieve is the invoker. This is the *uniform* surface — one protocol, identical across backends — so library access stops being a per-CLI filesystem/config problem.

2. **Containment plane — a self-describing `ContainmentProfile` rendered to CLI args by `cli.go`.** No config files written (their formats/locations drift; the model can't reliably author them). Args are the stable interface with one maintenance point.

**Settled rules.**

- **Remove `--dangerously-skip-permissions` / `--yolo`.** Dropping them re-arms each CLI's native path gate → reads confine to `cwd` + `--add-dir`, killing the wander. This is the single most important change and is independent of the MCP.
- **Inheritance is always on, invisible, never enumerated.** Never pass `--strict-mcp-config` or override setting-sources. The user's `~/.claude` (servers, skills, CLAUDE.md, hooks) loads and runs on the user's own approvals. **Sieve does not read, display, or manage the user's config** — enumeration would be format-coupled and sometimes wrong, and *wrong info about a security boundary is worse than no info*. Verified: allow-rules union across sources, so the user's approvals are honored alongside Sieve's `--allowedTools` (Sieve adds, never replaces).
- **Sieve grants only what it owns, on top:** read-only baseline (`Read, Grep, Glob`) + its MCP + explicit profile additions.
- **Writes are opt-in.** Off by default; enabled only by the user adding a write tool (`Write`/`Edit`, or a write-capable MCP verb) to the profile. That is informed consent by the actual principal — the confused-deputy risk was never *write*, it was an untrusted page wielding a capability the user never chose.
- **No `fetch_url` / no reinvented WebFetch.** The Sieve MCP is the knowledge base only, not a web proxy. Fetching stays with the tools that already do it well — native `WebFetch` for general URLs, the user's Confluence/other MCPs for their domains — and the AI keeps routing between them untouched. A generic Sieve fetch tool would muddy that routing (heuristic tool-selection) and reinvent worse functionality. `WebFetch` is a **baseline profile tool** (web-clip fetch/summarise depend on it; this is strictly better than today's hidden grant). Optional hard URL scoping is each CLI's native rule (`WebFetch(domain:…)` / `--allow-url`), opt-in, not core.
- **One global profile now.** Per-operation profiles (keyed by prompt name, mirroring the existing `PromptTimeouts` map) are the recorded future home for "writes on for authored jobs, off for untrusted-content jobs" — additive, not needed yet.

## The `ContainmentProfile` (self-describing)

Each grant is an **object with a `baseline` flag**. The Go constructor seeds baseline entries; user additions are `baseline:false`. The settings panel renders the profile literally (baseline ⇒ locked/no-remove, added ⇒ removable); `cli.go` renders every entry uniformly to args and ignores `baseline` (a UI concern only). **Single source of truth, no drift:** change the constructor, the UI follows on next load.

```go
type ContainmentProfile struct {
    Tools       []ToolGrant `json:"tools"`
    Directories []DirGrant  `json:"directories"`
    McpServers  []McpGrant  `json:"mcpServers"`
}

func DefaultContainmentProfile() ContainmentProfile {
    return ContainmentProfile{
        Tools: []ToolGrant{
            {Name: "Read", Baseline: true},
            {Name: "Grep", Baseline: true},
            {Name: "Glob", Baseline: true},
            {Name: "WebFetch", Baseline: true}, // web-clip depends on it; visible, not hidden
        },
        Directories: []DirGrant{
            {Kind: "library", Label: "Library",      Baseline: true},
            {Kind: "note",    Label: "Current note", Baseline: true},
        },
        McpServers: []McpGrant{
            {Name: "sieve", Builtin: true, Baseline: true},
        },
    }
}
```

**Persistence — defaults in code, overrides in file:**
- Serialise: **drop `baseline:true`** entries; `settings.json` holds only user additions.
- Deserialise: start from `DefaultContainmentProfile()`, then append entries from JSON; **dedup by name, baseline wins** (guards a user-added tool later promoted to baseline).

Baseline directories are **symbolic** (`kind: library|note`, resolved to paths per-invocation); user dirs carry a literal `path`. The Sieve MCP baseline entry is symbolic (`builtin:true`); its runtime URL + per-run bearer token are generated per call and **never persisted** (they would be stale/secret-leaking in a synced library).

Persisted example (Confluence + language-server inherited from `~/.claude`, *not* here; user added the `acme-spec` dir and a Forgejo server):

```json
{ "ai": { "containment": {
  "directories": [ { "path": "/…/acme-spec" } ],
  "mcpServers":  [ { "name": "forgejo", "command": "forgejo-mcp",
                     "args": ["--url","https://git.stephenquinn.ie"] } ]
} } }
```

## `ContainmentProfile → args`, per backend

The renderer lives in `cli.go` (evolving `buildBaseArgs` into per-backend adapters). Scenario: baseline + user's Forgejo + inherited Confluence/language-server.

| Need | **claude** ✅ verified | **copilot** 📄 doc-mapped | **agy** ❗ degraded |
|---|---|---|---|
| Drop dangerous default | omit `--dangerously-skip-permissions` | omit `--yolo` | omit `--dangerously-skip-permissions` |
| Confine reads | `cwd`=note + `--add-dir <library>` (+ added dirs) | same + `--disallow-temp-dir` | `cwd`=note + `--add-dir <library>` |
| Inherited servers | automatic (user approvals) — no flag | automatic — no flag | unknown |
| Inject Sieve + Forgejo | `--mcp-config '<inline JSON>'` | `--additional-mcp-config '<inline JSON>'` | **no inject flag → dropped** |
| Allow their tools | `--allowedTools "…,mcp__sieve__*,mcp__forgejo__*"` | `--allow-tool "mcp__sieve__*,mcp__forgejo__*"` | **no per-tool flag** |
| Baseline read tools + WebFetch | `--allowedTools "Read,Grep,Glob,WebFetch,…"` | `--allow-tool "…"` (⚠ **not** `--available-tools` — whitelist would hide inherited) | via `--mode`/`--sandbox` (coarse) |
| Block shell/write (default) | denied by default (opt hard-block `--disallowedTools`) | `--deny-tool "shell,write"` | `--sandbox` |

**agy degradation (spiked 2026-07-16; surfaced in UI):** agy **is Antigravity** — config home `~/.gemini/` (the legacy dir Antigravity reuses; the `gemini` CLI is **retired**, sign-in fails, so no `gemini`/`gemini mcp` reliance), agy-specific config `~/.gemini/antigravity-cli/`. Flags expose only `--add-dir`, `--mode {accept-edits,plan}`, `--sandbox` — **no per-tool allow/deny, and no `--mcp-config` inject flag.** agy *does* support MCP servers, but via its **config file** (`antigravity-cli/mcp_config.json`), not per-call. So the profile renders **directories only** under coarse read-only; the ephemeral Sieve MCP and user-added servers are **not injectable per-call** and fail closed (dropped — the agy renderer does not attempt or error, MCP section greyed with a "not available on agy" note). **agy's library access is the pragmatic first iteration: raw `--add-dir <library>` read of note files** (from the baseline library grant) — it gets the *files*, just not the Sieve MCP's distilled search/metadata layer. **Optional follow-up:** if agy library access is wanted, Sieve **writes `mcp_config.json` directly** (regenerated at startup — machine-local, not the synced library, so the "don't write CLI files" objection is weaker; regeneration handles the URL+token). See `../../agy-cli-args.md`.

### Verified on the installed claude CLI

- Injected `--mcp-config` server is **trusted headless** (no approval prompt), tool usable with `--allowedTools "mcp__<server>__*"`.
- `--mcp-config` accepts **inline JSON** (no file needed).
- Per-server wildcard `mcp__<server>__*` works; fully-wildcard `mcp__*` is **rejected** in allow rules.
- Allow-rules **union across sources** — a `--settings` allow is honored even when `--allowedTools` omits it (⇒ inherited approvals survive; Sieve need not enumerate them).

## The internal Sieve MCP

- **HTTP handler mounted on the existing chi router** (`/mcp`), sharing the service layer and the materialized index. Verb handlers are **transport-agnostic functions over the services**, not methods on an HTTP handler.
- **Served only while the app is open** (minimise to keep available). No stdio/daemon mode — "then just open the app" is the honest answer.
- **Auth:** bind `127.0.0.1` + a per-run bearer token in the injected config header, so only the CLI Sieve launched can reach it.
- **Read-only v1** (`search`, `get_meta`, `get_note`, `list_facets`). Distilled metadata by default; a body only on explicit `get_note`, so bulk-read is visible at a Sieve-owned boundary.

## Rationale

- **Symmetry restored.** The asymmetry that made per-CLI config feel wrong came from expressing *capability* through each CLI's idiosyncratic config surface. Move capability to the uniform MCP; the per-backend residue is a short, stable lockdown-arg list in one file.
- **Confused deputy, correctly scoped.** Untrusted content can't wield authority the user never granted: writes/servers are visible, opt-in, user-owned; reads confine to the library.
- **No drift, no wrong info.** Self-describing profile (baseline in code) + never enumerating the user's config = the panel only ever shows accurate, Sieve-authored facts.

## Open / future

- **agy spike DONE (2026-07-16):** agy=Antigravity, headless works, MCP only via `~/.gemini/antigravity-cli/mcp_config.json` (no inject flag), no per-tool allowlist. Default = directories-only; optional startup config-file injection is the only path to agy library access. Remaining: confirm `--mode plan`/`--sandbox` actually confine reads under a live run.
- **copilot** — flags are doc-mapped, not run (not installed here); confirm denylist-preserves-inheritance behavior.
- **Per-operation profiles** — `map[string]ContainmentProfile` keyed by prompt name, mirroring `PromptTimeouts`; the home for the untrusted-content write distinction.
- **MCP write verbs** (`create_block`, `propose_view`) — the blocks-all-the-way-up seam; gated by the same profile opt-in.
- **Cross-app server** — the same `/mcp`, connected to by VSCode/Claude Code as a client (Sieve as a knowledge server). Flag planted, not scheduled; keeps the MCP a first-class service, not a CLI appendage.
