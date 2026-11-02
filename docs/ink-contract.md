# Ink contract

**Status:** Normative. Implemented by SieveInk (the Boox companion) and by Sieve (`sieve/ink/`,
`frontend/src/static/renderers/ink-renderer.js`). Design and rationale:
`docs/design/specs/2026-10-31-boox-companion-live-ink-design.md` (epic #204).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. A change to anything
here is a contract bump on both sides.

---

## 1. Units

- **Page units.** x runs 0..1 across the page width; y runs 0..1/`pageAspect` down a fixed
  page. A page is square-unit: one page unit is the same length on both axes.
- **Times.** `startMillis` is milliseconds since the note's `created`; `tMillis` is
  milliseconds since the stroke's first point.
- **Ids** are UUIDv7 strings, minted by the companion for notes, pages and strokes. Sieve
  never mints or rewrites them.

## 2. Note model

```
Note
  id          uuid
  created     RFC 3339 timestamp
  title       string, may be empty
  pageAspect  number > 0, page width / page height (Note Air 2 portrait: 1404/1872)
  template    TemplateRef | null          the note default
  pages       ordered list of Page

Page
  id          uuid
  template    TemplateRef | null          null = the note default
  bounds      "fixed" | "unbounded"
  strokes     ordered list of Stroke      the replay of the log, never stored as such

Stroke
  id           uuid
  tool         "pen" | "pencil"
  widthClass   1 | 2 | 3
  startMillis  uint32
  points       list of Point, at least one

Point
  x, y         page units (float)
  pressure     0..1 (float)
  tMillis      uint32
  tiltX, tiltY degrees, int8
```

- `bounds: fixed` is a sheet of the note's aspect. `bounds: unbounded` is a whiteboard: the
  plane has no edge and coordinates MAY fall outside 0..1 and below 0. Where a viewer's
  window sits on an unbounded page is UI state and MUST NOT appear in the log.
- Strokes are never edited in place. The model is the replay of the log (§3).

## 3. Operation log

The log is the note. It is an ordered list of records, each with a `seq` exactly one greater
than the previous; the first record is `seq` 1.

| op | fields | |
|---|---|---|
| `note-header` | `id`, `created`, `title`, `pageAspect`, `template` | `seq` 1; re-emitted with a new `seq` on any header change |
| `page-add` | `page`, `index`, `template`, `bounds` | |
| `page-remove` | `page` | |
| `page-template` | `page`, `template` | |
| `stroke-add` | `page`, and the Stroke's `id`, `tool`, `widthClass`, `startMillis`, `points` | |
| `stroke-remove` | `page`, `id` | |

Replay rules:

1. The eraser removes whole strokes: touching any point of a stroke emits one
   `stroke-remove`. There is no partial erase and no stroke edit.
2. Undo of a `stroke-remove` is a `stroke-add` with the same id and points. Undo of a
   `page-remove` is a `page-add` with the same page id and index. Undo is a new record, never
   a rewind.
3. A `stroke-add` whose id is currently present, and a `stroke-remove` or `page-remove` of an
   absent id, are no-ops.
4. A removed page's strokes become unreachable; they are not deleted from the log.
5. Pages are never reordered.
6. Neither side compacts or rewrites the log. A replica holding `seq` 1..N holds the complete
   history to N.

## 4. Codecs

One record shape (§3), three encodings: the **JSON Lines** asset (§4.1), the **export page**
that fixtures use (§4.2), and the **binary** records of the radio (§4.3).

### 4.1 JSON Lines — the log on disk

`strokes.jsonl` holds the log, one record per line.

- UTF-8, each line one JSON object followed by `\n`; no blank lines, no trailing data.
- Lines appear in `seq` order with no gaps. A line that fails to parse, or breaks contiguity,
  truncates the replay to the line before it.
- Keys appear in the order listed below. Writers MUST NOT add keys; readers MUST reject an
  unknown `op`.
- Numbers are JSON numbers; a float is written in its shortest round-tripping form.
- `template` is `null` or a TemplateRef object `{"id": …, "params": {…}}` (§6).

```
{"seq":1,"op":"note-header","id":U,"created":T,"title":S,"pageAspect":F,"template":R}
{"seq":N,"op":"page-add","page":U,"index":I,"template":R,"bounds":"fixed"|"unbounded"}
{"seq":N,"op":"page-remove","page":U}
{"seq":N,"op":"page-template","page":U,"template":R}
{"seq":N,"op":"stroke-add","page":U,"id":U,"tool":"pen"|"pencil","widthClass":1|2|3,"startMillis":I,"points":[P,…]}
{"seq":N,"op":"stroke-remove","page":U,"id":U}

P = [x, y, pressure, tMillis, tiltX, tiltY]
```

### 4.2 Export page — fixtures

What SieveInk's Export writes and what the renderer takes: one page, already replayed.

```json
{"note": {"id": U, "created": T, "title": S, "pageAspect": F, "template": R},
 "strokes": [{"id": U, "tool": "pen", "widthClass": 2, "startMillis": I,
              "points": [{"x": F, "y": F, "pressure": F, "tMillis": I, "tiltX": I, "tiltY": I, "size": F}]}]}
```

`size` is the Onyx touch size, carried for fidelity; it is not part of the record and no rule
reads it.

### 4.3 Binary — the live point feed

The stroke under the pen (design §7.4) travels as fixed-size records: little-endian, type
byte first, the size fixed per type. A record MAY span transport SDUs; a receiver buffers
until the record is whole. An unknown type byte is a framing loss: the receiver MUST drop the
connection.

| type | name | bytes | fields after the type byte |
|---|---|---|---|
| 1 | CLOCK | 7 | `tabletMs` u32, `pageAspect` u16 (×10000) |
| 2 | BEGIN | 11 | `strokeSeq` u32, `tool` u8 (0 pen, 1 pencil), `widthClass` u8, `tabletMs` u32 |
| 3 | POINT | 17 | `strokeSeq` u32, `x` u16, `y` u16, `pressure` u16, `tiltX` i8, `tiltY` i8, `tabletMs` u32 |
| 4 | END | 13 | `strokeSeq` u32, `pointCount` u32, `tabletMs` u32 |
| 5 | REMOVE | 5 | `strokeSeq` u32 |

- `x`, `y` are page units × 32768 (range [0, 2)); `pressure` is × 65535.
- `tabletMs` is the tablet's monotonic clock in ms, truncated to u32, taken when the record
  is made. A point's `tMillis` is its `tabletMs` minus its BEGIN's.
- `strokeSeq` names a stroke within one connection; it is not the stroke id. `pointCount` is
  the number of POINTs sent for the stroke.
- Points are ephemeral: never logged, acked or reconciled. The committed stroke arrives as a
  `stroke-add` record of the log. A receiver that joins mid-stroke draws from the next BEGIN.

The binary encoding of log records on the replication channel (design §7: length-prefixed,
CRC32 per record, the `HEAD` hash chain over records) is not fixed by this version.

## 5. On-disk form

A Digital Note is a Things block (`.meta` `type: block`, `kind: digital-note`) whose payload
is `{uuid}.block`, YAML, beside its **source** asset in the same directory. The block never
carries ink.

| field | |
|---|---|
| `id` | the Thing's uuid, Sieve's own (`ident.New`), never the companion's note id |
| `kind` | `digital-note` |
| `title` | the note title |
| `note` | the header: `created`, `pageAspect`, `template`, and `pages`, a list of `{id, template, bounds}` |
| `note_companion` | the companion's identity (the GATT `identity` value) |
| `note_source_id` | the companion's note id |
| `note_synced_seq` | the `seq` of the last record in the source |
| `reading` | the reading job's state; owned by the reading job |
| `source` | the source asset's absolute address, `sieve://{thing}/{key}` |

- **StrokeBasedNote:** `source` is `strokes.jsonl` (§4.1).
- **FileBasedNote:** `source` is the PDF or PNG a producer delivered.
- A committed record is appended to the source first, then sent to an open lens. Points of
  the live feed go to an open lens only and never to the source.
- `note_synced_seq` is the catch-up cursor: replication resumes with `OPEN {noteId, haveSeq =
  note_synced_seq}`.
- One Sieve holds at most one live Thing per `(note_companion, note_source_id)`.

## 6. Templates

A template is data, never an image: `TemplateRef = {id, params}`, lengths in page units.

| id | params |
|---|---|
| `blank` | none |
| `ruled` | `spacing`, `margin` |
| `grid` | `spacing` |
| `dots` | `spacing` |

An unknown id is drawn as `blank` and the page is marked "unknown template". The drawing rules
for `ruled`, `grid` and `dots` are fixed with the first fixture that uses one; until then
every template is drawn as `blank`.

## 7. Transport

- **Roles.** Companion = BLE peripheral and GATT server; Sieve = central.
- **Reserved UUIDs.**

  | UUID | |
  |---|---|
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da00` | Sieve ink service, advertised |
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da01` | `psm`: read, u16 little-endian |
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da02` | `identity`: read, UTF-8 |

- **Channel.** An LE L2CAP connection-oriented channel opened by the companion with the
  *insecure* listener (`listenUsingInsecureL2capChannel`). The PSM is dynamic: Sieve MUST
  read `psm` on every connect and MUST NOT cache it.
- **Link priority.** Once the channel is accepted, the companion MUST open a GATT client
  handle on the same link and request `CONNECTION_PRIORITY_HIGH`. Requested earlier, it is
  overridden.
- **Matching.** Sieve matches a companion by the service UUID, never by its address, which
  is a resolvable private address that changes when the tablet's adapter restarts.

## 8. Rendering

Sieve's renderer is the only implementation; SieveInk draws with the Onyx engines. All
lengths are in page units unless marked as grid units.

**Grid.** Outlines are computed and emitted in a grid of 1404 units across the page (the
Note Air 2's pixel width), as `viewBox="0 0 1404 round(1404/pageAspect)"`. The grid is
required because the outline algorithm's thresholds are absolute.

**Widths.** Nominal class widths `n(1) = 0.0012`, `n(2) = 0.0024`, `n(3) = 0.0045`. Tilt
has no effect on any rule.

| tool | drawn width at pressure p |
|---|---|
| pen | `(0.002991 + 0.76·n) · (0.5 − 0.75·(0.5 − p)) / 0.8375` — so `0.002991 + 0.76·n` at p = 0.95 |
| pencil | `(0.002991 + 1.09·n) · min(1, p/0.8)^0.8` |

(0.002991 is 4.2 grid units.)

**Pen.** One outline per stroke: perfect-freehand 1.2.3 `getStroke` over
`[x·1404, y·1404, pressure]` with `size` = the pen width at p = 0.5 in grid units,
`thinning 0.75, smoothing 0.5, streamline 0.3, simulatePressure false, last true`. Fill black.

**Pencil.** The stroke is cut into chunks: for i = 0, 10, 20, … the points
`max(0, i−1) .. i+10` (inclusive), skipping a chunk of fewer than two points. Each chunk is
one outline at the chunk's mean pressure p̄: `size` = the pencil width at p̄ in grid units,
`thinning 0, smoothing 0.5, streamline 0.2, simulatePressure false, last true`, start and end
`{taper: 0, cap: true}`. Fill black, then toned.

**Tone** is dot density. A chunk's darkness is `min(1, 0.10 + 0.95·p̄^1.3)`; its band is
the first of the keep fractions `0.12, 0.22, 0.34, 0.48, 0.64, 0.82, 0.96` that is ≥ the
darkness (the last band otherwise). Each band is one group under one filter that keeps that
fraction of a shared stipple:

```
<filter id="ink-b{i}" x="0" y="0" width="1" height="1">
  <feTurbulence type="turbulence" baseFrequency="0.7" numOctaves="2" seed="11" result="n"/>
  <feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="o"/>
  <feComponentTransfer in="o" result="s"><feFuncR type="linear" slope="40" intercept="{−40·t}"/></feComponentTransfer>
  <feColorMatrix in="s" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="m"/>
  <feComposite in="SourceGraphic" in2="m" operator="in"/>
</filter>
```

The threshold `t` for a keep fraction k is interpolated linearly in this measured table of
(keep, threshold): (1.0, −0.05) (0.98, 0) (0.95, 0.04) (0.88, 0.08) (0.79, 0.12) (0.68, 0.16)
(0.57, 0.20) (0.45, 0.25) (0.34, 0.30) (0.23, 0.36) (0.14, 0.42) (0.05, 0.55), and the
intercept is written to two decimals. `baseFrequency` is per grid unit (982.8 per page width);
1.1 aliases into pixel rows and columns.

**Document.** In paint order: a white background; group `pen`; groups `b0`…`b6`, each under
filter `ink-b{i}`; group `live`. Each group is `<g data-ink="{name}">`. A pen stroke is
`<path data-stroke="{id}">`; a pencil stroke is, in each band it touches,
`<g data-stroke="{id}">` of one `<path>` per chunk.

**Path data.** For an outline o₀…oₘ: Douglas–Peucker with tolerance 0.25 grid units, vertices
snapped to multiples of 0.2 and consecutive duplicates dropped; then `M o₀`, a quadratic with
control o₀ to mid(o₀,o₁), and a smooth quadratic (`t`) through each following midpoint, so each
vertex is its segment's control point; closed with `z`. Coordinates after the first are
relative, in tenths, with no redundant zeros or separators. Fewer than three vertices draw
nothing.

**Live.** A stroke under the pen is drawn in the `live` group from the points so far: a pen
stroke exactly as it will commit; a pencil stroke as its chunk outlines in one `#808080` path,
untoned. At END the live path is replaced by the committed markup.

## 9. Conformance set

`docs/design/specs/assets/` holds the fixtures, one directory each:

| file | |
|---|---|
| `boox-page-strokes.json` | a page as SieveInk exports it (§4.2) |
| `boox-page-strokes.svg` | what the renderer MUST emit for it, byte for byte |
| `boox-tablet-render.png` | what the tablet drew; the look-and-feel reference, judged by eye, never diffed |

Current set: `2026-10-31-boox-test-page`, `2026-11-02-live-page`,
`2026-11-02-width-tilt-pressure-ladder`. `frontend/test/ink-renderer.test.js` pins every
SVG. A change that alters any fixture's SVG is a contract change and lands with this document
and the regenerated SVGs in the same commit. SieveInk's obligation is to export pages
faithfully; it has no SVG to match.
