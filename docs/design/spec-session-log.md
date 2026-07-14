# Specification: Session Log

## 1. Overview

The session log is a view over version history that groups saves into meaningful editing sessions and filters out noise. It exists at two scopes:

| Scope | Entry point | Question it answers |
|-------|------------|---------------------|
| **Per-document** | Meta panel, version history tab | "What changed in this note over time?" |
| **Global** | Keyboard shortcut overlay | "What did I work on across everything?" |

Both scopes share the same session abstraction, the same grouping algorithm, the same filter, and the same AI summary mechanism. The only difference is the query scope.

---

## 2. The Session Primitive

```go
type Session struct {
    DocID      string        // document UUID
    DocTitle   string        // document title at session end
    Start      time.Time     // timestamp of first save in session
    End        time.Time     // timestamp of last save in session
    Versions   []VersionRef  // all saves in this session, chronological
    NetDiff    int           // net character change: len(last.Body) - len(first.Body)
    Summary    string        // AI-generated, lazy/cached. Empty until generated.
    SummaryKey string        // hash of (DocID + first.ID + last.ID) — cache key
}
```

### 2.1 Grouping algorithm

Given a document's `[]VersionRef` ordered newest-first:

1. Reverse to chronological order
2. Walk the list; start a new session whenever the gap between consecutive versions exceeds **30 minutes**
3. Each resulting group is a candidate session

The 30-minute threshold is configurable via settings.

### 2.2 Noise filter

A candidate session is **dropped** (not shown) if:

- The net character difference between `session.Versions[0]` and `session.Versions[last]` is **less than 10 characters** after stripping whitespace, OR
- The diff is whitespace-only

This requires loading the body of the first and last version snapshot in the session. The middle snapshots are never read for filtering purposes.

Dropped sessions still exist in the version store — they are invisible in the log UI but remain available for crash recovery.

---

## 3. Per-Document Session View

Replaces the current flat version list in the meta panel history tab.

```
Version History
───────────────────────────────────────────
▼ Today, 14:30 – 16:15  (45 saves, 1h 45m)
  "Rewrote the methodology section, added S3 vision doc"
  [Restore to this version]  [View diff]

▼ Today, 09:00 – 09:45  (12 saves, 45m)
  "Initial outline and rough first draft"
  [Restore to this version]  [View diff]

▼ Yesterday, 21:10 – 21:40  (8 saves, 30m)
  "Light edits to the introduction"
  [Restore to this version]  [View diff]
───────────────────────────────────────────
```

- Expanding a session shows the individual `VersionRef` entries for granular recovery
- "Restore" restores to the last version in the session
- "View diff" shows the diff from first to last version in the session (the net change)
- Sessions with no AI summary yet show a "Summarise" button; generated summaries are cached

---

## 4. Global Session Log

A keyboard shortcut (e.g. `Cmd+Shift+H`) opens an overlay panel — not fullscreen, perhaps 70% width centred. Shows all non-trivial sessions across all documents, ordered by recency.

```
Session Log                                              [×]
────────────────────────────────────────────────────────────
Saturday 3 May
  16:15  Sieve feature spec        1h 45m  "Rewrote methodology, added S3 vision"
  09:00  Sieve feature spec          45m  "Initial outline and rough draft"

Friday 2 May
  21:10  Research notes              30m  "Light edits to introduction"
  14:20  Meeting notes                5m  "Added action items from design review"
  09:30  Research notes            2h 0m  "Expanded background section"

Thursday 1 May
  ...
────────────────────────────────────────────────────────────
```

- Clicking a row opens that document and navigates to that version in the meta panel
- Each row is one session; trivial sessions are filtered before display
- Grouped by calendar day
- AI summaries generated lazily — rows without a summary show "—" until generated

---

## 5. AI Summary Generation

**Prompt:**
```
Given this document diff, write a single sentence (under 12 words) describing what changed:

<diff>
{first_body vs last_body unified diff}
</diff>
```

**Generation:** lazy — triggered when the session row is first displayed. Runs via the existing CLI integration.

**Cache key:** `sha256(DocID + ":" + firstVersionID + ":" + lastVersionID)` — deterministic, content-addressed. Same session always produces the same key regardless of when it is computed.

**Cache hit:** if a summary exists for the key, display it immediately — no CLI call.

---

## 6. Go Handler Endpoints

```
GET  /api/sessions?doc={uuid}          — per-document sessions
GET  /api/sessions                     — global sessions (all docs)
POST /api/sessions/summarise           — trigger AI summary for one session
     body: { docID, firstVersionID, lastVersionID }
```

Session computation is stateless — derived from existing `VersionRef` data on each request. No new version storage required for the grouping or filtering.

Summary persistence is the open question — see Section 7.

---

## 7. Persistence — Open Question

> **Resolution note (2026-07-14):** `search_and_ranking_concept.md` and the
> #37 view-system direction effectively close this question. The
> architectural constraints there (no SQLite — locking + breaks
> Nextcloud/Syncthing file replication; "just files") plus the shared
> implementation concept (in-memory materialized view built at startup,
> watcher hot-reload) select the **sidecar-file** option below, with the
> in-memory index providing global queryability. Sessions become one feed
> of a shared Doc/View/Search index also consumed by sidebar views (#37)
> and search ranking — decide details once, at whichever detailed design
> lands first.

The session grouping and noise filter are pure computation over existing `VersionRef` data. No new storage needed for those.

AI summaries must be persisted — recomputing them on every request is expensive. The right persistence mechanism is the subject of the conversation that follows this spec.

Options under consideration:

- **Sidecar file per document** — `.history/{uuid}.sessions.json` alongside the snapshot files. Simple, co-located with the data it describes, works with `FileStore` and `S3Store`.
- **Global sessions index** — a single store-level file. Easier to query globally; harder to keep consistent.
- **Embedded SQLite** — a local index database. Powerful, but introduces a new dependency and raises questions about S3 compatibility.

Each has different implications for the S3 / web app direction. Needs discussion.
