# How ink works in Sieve

A map of Sieve's side of SieveInk companions: what each type in `sieve/ink/` is and does, and
which views draw a Digital Note. The wire, the records and the rendering rules are
`docs/ink-contract.md`; this file names the Go and JS that implement them.

Related: the sidebar's Notebooks and Diary items are in `docs/how-the-sidebar-works.md`; the ink
lens and the ink renderers are in `docs/frontend-packages.md` (§ `lens/ink/`, § `renderers/`).

## 1. Packages

| Package | What it is |
|---|---|
| `sieve/ink/` | `InkService` and everything below. Sits beside `block/processors`: it imports `services/`, `domain/` and `block/` (for its kind), and nothing above it but the composition root imports it. |
| `sieve/ink/link/` | The replication protocol of `docs/ink-contract.md` over any `io.ReadWriter`: pairing key and proofs, sealed frames, records and their codecs, live feed, `Session`, `ScriptedCompanion` for tests. Imports no Sieve or Bluetooth package; pins SieveInk's vectors file (`vectors_test.go`). |
| `sieve/ink/radio/` | `Radio.Dial` → `Link`: Bluetooth per platform, a TCP radio for development and tests. The only package that imports Bluetooth, pinned by its import-walk test (`imports_test.go`). |

## 2. InkService

`InkService` = dial → replicate → follow. It holds the link state and its listeners, the
Settings → Notebooks status, and page export.

## 3. Replication: NoteReplicas

`NoteReplicas` holds a companion's notes as digital-note block containers. Each replica is
following, catching up or rewound.

- **Catch-up** (a HEAD past the cursor, to its DONE) is staged by `NoteStaging` in
  `os.TempDir()/sieve-ink/{uuid}.jsonl`, outside the library. It is resumed after a lost link and
  published at DONE in one write — the whole `strokes.jsonl` when there was none, else one append.
  Its records are heard only then; a first log is heard as `LogRestarted`.
- **Damage** rewinds the replica to its last good record. Damage is: a write leaving the log the
  wrong length, a replay short of the face's `note_synced_seq`, staged records not reaching the
  cursor.
- **A chain mismatch, a `REFUSE` ahead, and `InkService.Resync`** rewind it to none. The damaged
  log is kept whole as `strokes.aside-N.jsonl` and the note is opened again from where it then
  stands (`link.ErrRewound`, `Session.Reopen`).
- **Resync** is `POST /api/ink/notes/{uuid}/resync` and Resync on the notebook menus. It answers
  `ErrNotOffered` unless the note's tablet is connected and lists it.

### Sync jobs

Every sync is a job on the `JobTracker` (`syncJobs`, category `ink-sync`), its tab spinning,
labelled Syncing/Repairing/Resyncing {name}. Progress is `done / total` = the record's seq of the
HEAD's, through `JobTracker.Update`. A job is queued when NOTES lists the note behind, active from
its HEAD, and finished at publish, at a `REFUSE` not ahead, and at the session's end.

### A record of an unknown op

A record of an op this Sieve does not know parks its note for the session (`link.ErrUnknownOp`,
`Observer.Parked`): nothing more of it is taken, the link and every other note carry on, and
Settings shows it as needing a newer Sieve.

## 4. The kind and the log

- **`DigitalNoteKind`** — the kind and its `.meta` face. The face carries the note's properties
  (`note_type`; `note_period` when it is a `YYYY-MM` month; `note_properties` = the whole map as
  JSON) and `note_device_id`.
- **`StrokeBasedNote`** — the replay of a `strokes.jsonl` log: the note's and each page's
  `Properties` (contract §3: last record wins, unknown keys kept, a page's `name` among them) and
  its §4.2 export page.
- **`LivePen`** — live records as marks in page units.

## 5. Notes held open for views

- **`OpenNotes` / `OpenNote`** — the notes held open for views, each held by the destinations
  (sockets) that asked its pages. An open note answers pages and hands out stroke changes at the
  seq it reflects, and is restarted when its log is rewound or first published.
- **A page of a note with no published log** is refused as `syncing` (`ErrSyncing`,
  `protocol.InkPageSyncing`). The socket is kept as a holder so the restart reaches it. The page,
  transcript and live views show this as a `SyncingPanel` (`renderers/syncing-panel.js`) until
  that restart.
- **`PageDrawings`** — the SVG a view drew of a fixed page, kept as the asset
  `notebook-{page}.svg` beside the log and rewritten in place. It is handed back in place of the
  page while the note's key and the asking renderer's version are the ones it was made at. The key
  is the SHA-256 of the log's bytes, with their length and last seq; `OpenNote` checks it without
  replaying the log.

## 6. The Live view

`LiveView` is the tablet's live view as a container of its own, kind `ink-live`. Its uuid is
minted per run and stored nowhere. It is the Router's source for that uuid from the first live
note until `LiveGrace` (30 s) after the last. Its attrs name the live note, page and waiting state
beside that note's `note`/`note_device`. It is offered by name to a search that is not
durable-only.

## 7. Finding notes: Notebooks

`Notebooks` is the Router's source for Digital Notes, registered after the documents and before
`BlockSource`. Notes are found by name, summary and keywords/categories, read from `.meta` alone
(`InkService.searchNotebooks`), and resolved through `editor.BlockSource` behind the
`ink.ContainerNodes` port.

## 8. Naming

- **`NoteNamer`** names a settled note: no record for `ink.settle_seconds` (default 5 min), live or
  not, counted across a restart from its face's `modified`. It runs ONE AI-pool job showing the
  model the note's first eight page images through `AIService.DescribeNote` (prompt `note-meta`),
  keeps the answer in `.meta` and sends it to the tablet as `META`.
- **`NameNow`** names one at once: `POST /api/ink/notes/{uuid}/describe`, the `ink-describe` frame,
  the notebook menus and the Meta panel's button.
- **`InkService.Rename`** is a name given by hand (Rename… on the notebook menus,
  `POST /api/ink/notes/{uuid}/rename`, `.meta` `note_named_by: hand`). The namer and `NameNow` keep
  it while describing the rest; it is sent as `META` as the AI's is. A blank one hands naming back.
- **A note whose `type` is `diary`** is named by its tablet (`note_named_by: tablet`, `NamedBy`):
  described as the rest are, its `META` title empty, Rename refused (`ErrNamedByTablet`) and not
  offered.

## 9. Transcripts

`PageTranscripts` transcribes a page on demand with ONE AI-pool job per page through
`AIService.TranscribePage` (prompt `page-transcript`). Its parts are made prose and diagram blocks
(PlantUML drawn through `PlantumlService`) and kept as `transcript-{page}-{key}.json`. A page is
never transcribed twice at one key, and a superseded key's transcript is dropped. Its state —
none/ready/stale × running × available — reaches the note's socket as `ink-transcript-changed`.
`EditorService.NewDocument` copies a transcript into an ordinary note.

## 10. The Diary

The Diary is derived, never stored. `ink.Status.Diaries` groups the synced notes whose
`SyncedNote.Type` is `diary` by `DeviceID` into `ink.Diary` values, chunks ordered by `Period`
then `Created` (the note-header's `created`, the face's `note_created`), read from the face or the
open replica alike.

`InkService.DiaryOn(diary, day)` answers where one opens on a day: the chunk whose month holds the
day, at its last page named the day's date, else its last page; the newest chunk when none holds
it. `GET /api/ink/diary/today?device=` (`protocol.InkDiaryTodayResponse`) asks it for today by
`InkHandler`'s clock. The answer `sieve://{chunk}/{page}` is opened through
`window.sieveWorkspace.openAddress`, which has the note's lens reveal that page.
