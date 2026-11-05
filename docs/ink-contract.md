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
  device      DeviceInfo                  the device it was written on, for the note's life
  pages       ordered list of Page

DeviceInfo
  id          string, a stable opaque id for the device under the companion's signing key
  name        string, what the user called the device when the note was created
  model       string, manufacturer and model

Page
  id          uuid
  template    TemplateRef | null          null = the note default
  bounds      "fixed" | "unbounded"
  strokes     ordered list of Stroke      the replay of the log, never stored as such

Stroke
  id           uuid
  tool         "pen" | "pencil"
  widthClass   1 | 2 | 3
  startMillis  uint64
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
  A live feed may carry the window (§4.3 VIEW), and a consumer may ignore it. A replay, if ever
  built, derives its framing from the strokes, or gets a new additive op then.
- `bounds` is chosen when the note is created and never changes, in either direction. A
  whiteboard note has exactly one page, `unbounded`; every other note has only `fixed` pages.
  The producer enforces this at creation; a consumer replays what it receives.
- `device` is fixed when the note is created and is the same in every `note-header` of the note. A
  later change of the device's name does not reach existing notes. The same physical device may
  report different ids under different signing keys or after a factory reset, so `id` identifies a
  device for display and grouping and MUST NOT be used as a security credential.
- Strokes are never edited in place. The model is the replay of the log (§3).

## 3. Operation log

The log is the note. It is an ordered list of records, each with a `seq` exactly one greater
than the previous; the first record is `seq` 1.

| op | fields | |
|---|---|---|
| `note-header` | `id`, `created`, `title`, `pageAspect`, `template`, `device` | `seq` 1; re-emitted with a new `seq` on any header change |
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
7. A `page-add` of a removed page's id restores that page with the strokes it had and takes the
   record's `template`. A `page-add` of an id present is a no-op. A stroke record naming a page not
   currently present is a no-op.

## 4. Codecs

One record shape (§3), and its encodings: the **JSON Lines** asset (§4.1), the **export page**
that fixtures use (§4.2), the **binary** live point feed (§4.3) and the **binary** log records
of the device and the radio (§4.4).

### 4.1 JSON Lines — the log on disk

`strokes.jsonl` holds the log, one record per line.

- UTF-8, each line one JSON object followed by `\n`; no blank lines, no trailing data.
- Lines appear in `seq` order with no gaps. A line that fails to parse, or breaks contiguity,
  truncates the replay to the line before it.
- Keys appear in the order listed below. Writers MUST NOT add keys; readers MUST reject an
  unknown `op`.
- Numbers are JSON numbers; a float is written in its shortest round-tripping form.
- `template` is `null` or a TemplateRef object `{"id": …, "params": {…}}` (§6).
- `created` is an RFC 3339 time in UTC with `Z`, to the millisecond, the fraction left out when
  it is zero. A reader rejects anything finer, and keys that are missing, extra or out of order.

```
{"seq":1,"op":"note-header","id":U,"created":T,"title":S,"pageAspect":F,"template":R,"device":D}
{"seq":N,"op":"page-add","page":U,"index":I,"template":R,"bounds":"fixed"|"unbounded"}
{"seq":N,"op":"page-remove","page":U}
{"seq":N,"op":"page-template","page":U,"template":R}
{"seq":N,"op":"stroke-add","page":U,"id":U,"tool":"pen"|"pencil","widthClass":1|2|3,"startMillis":I,"points":[P,…]}
{"seq":N,"op":"stroke-remove","page":U,"id":U}

P = [x, y, pressure, tMillis, tiltX, tiltY]
D = {"id": S, "name": S, "model": S}
```

### 4.2 Export page — fixtures

What SieveInk's Export writes and what the renderer takes: one page, already replayed.

```json
{"note": {"id": U, "created": T, "title": S, "pageAspect": F, "template": R,
          "device": {"id": S, "name": S, "model": S}},
 "strokes": [{"id": U, "tool": "pen", "widthClass": 2, "startMillis": I,
              "points": [{"x": F, "y": F, "pressure": F, "tMillis": I, "tiltX": I, "tiltY": I, "size": F}]}]}
```

`size` is the Onyx touch size. It is not part of the record, no rule reads it, and a page exported
from its replay carries 0. A fixture that predates `device` has none, and no rule reads that either.

### 4.3 Binary — the live point feed

The stroke under the pen (design §7.4) travels as fixed-size records: little-endian, type
byte first, the size fixed per type. An unknown type byte is a framing loss: the receiver MUST
drop the connection.

| type | name | bytes | fields after the type byte |
|---|---|---|---|
| 1 | CLOCK | 7 | `tabletMs` u32, `pageAspect` u16 (×10000) |
| 2 | BEGIN | 19 | `strokeSeq` u32, `tool` u8 (0 pen, 1 pencil), `widthClass` u8, `tabletMs` u32, `originX` i32, `originY` i32 |
| 3 | POINT | 17 | `strokeSeq` u32, `x` u16, `y` u16, `pressure` u16, `tiltX` i8, `tiltY` i8, `tabletMs` u32 |
| 4 | END | 13 | `strokeSeq` u32, `pointCount` u32, `tabletMs` u32 |
| 5 | REMOVE | 5 | `strokeSeq` u32 |
| 6 | VIEW | 9 | `originX` i32, `originY` i32 |

- `x`, `y` are page units × 32768 (range [0, 2)), relative to the stroke's origin; `pressure`
  is × 65535.
- A BEGIN's origin is in page units × 32768. A point's place is origin + (x, y). A fixed page
  sends 0,0. An unbounded page sends the view's top-left when the pen landed, rounded down.
- VIEW is the top-left of an unbounded page's view, in the same units. It is sent when the
  page goes live, when a receiver joins, on a pan's steps at most once per 100 ms, and at a
  pan's end; never for a fixed page. It is ephemeral: never logged, acked or reconciled. A
  sender MAY drop it when the link falls behind, since only the latest matters. A receiver
  holding no VIEW places its window from BEGIN's origin.
- Records travel only inside INK frames (§7), whole. CLOCK goes on connect and every 2 s,
  with `pageAspect` 0 when no consented note is live.
- `tabletMs` is the tablet's monotonic clock in ms, truncated to u32, taken when the record
  is made. A point's `tMillis` is its `tabletMs` minus its BEGIN's.
- `strokeSeq` names a stroke within one connection; it is not the stroke id. `pointCount` is
  the number of POINTs sent for the stroke.
- Points are ephemeral: never logged, acked or reconciled. The committed stroke arrives as a
  `stroke-add` record of the log. A receiver that joins mid-stroke draws from the next BEGIN.

### 4.4 Binary: log records

The same encoding on the device's log and on the replication channel. All integers little-endian.

```
log file  := "SINKLOG2" frame*
frame     := length u32, body, crc u32       crc = CRC-32 (IEEE) of body; 1 <= length <= 16 MiB
body      := op u8, seq u32, fields
```

| op | name | fields |
|---|---|---|
| 16 | note-header | id, created i64 (Unix ms), title string, pageAspect f32, template, device |
| 17 | page-add | page id, index u32, template, bounds u8 (0 fixed, 1 unbounded) |
| 18 | page-remove | page id |
| 19 | page-template | page id, template |
| 20 | stroke-add | page id, stroke id, tool u8 (0 pen, 1 pencil), widthClass u8, startMillis u64, count u32, count × (x f32, y f32, pressure f32, tMillis u32, tiltX i8, tiltY i8) |
| 21 | stroke-remove | page id, stroke id |

An id is its 16 RFC 9562 bytes, most significant first. A string is u16 byte length + UTF-8. f32 is
IEEE 754 binary32. A template is u8 0 for null, or u8 1, id string, u8 count, count × (name string,
value f32), params in the order §6 lists them. A device is its id, name and model, each a string. Op
values do not overlap §4.3's type bytes.

The magic's last byte is the format's version. A log of another version is refused, not truncated,
and is left unaltered.

A reader stops at the first frame that is short, fails its CRC, does not decode, or whose seq is not
one greater than the last; everything before it is the log. What follows is not part of the log.

`headHash`: `h(n) = SHA-256(h(n-1) ‖ body(n))`, `h(0)` = 32 zero bytes. The encoding is canonical: a
replica holding JSON Lines (§4.1) re-encodes each record to its body to compute the chain, which holds
because §4.1 floats are shortest round-tripping binary32.

## 5. On-disk form

A Digital Note is a `BlockContainer` (`.meta` `type: block`): one block written as YAML to
`{uuid}.block`, whose first line is `kind: digital-note`, beside its **source** asset in the same
directory. The block never carries ink.

| field | |
|---|---|
| `id` | the container's uuid, Sieve's own (`ident.New`), never the companion's note id |
| `kind` | `digital-note`, the file's first line |
| `title` | the note title |
| `note` | the header: `created`, `pageAspect`, `template`, and `pages`, a list of `{id, template, bounds}` |
| `note_device` | the note's `device` from its header: `{id, name, model}` |
| `note_companion` | the companion's identity (the GATT `identity` value) |
| `note_source_id` | the companion's note id |
| `note_synced_seq` | the `seq` of the last record in the source |
| `reading` | the reading job's state; owned by the reading job |
| `source` | the source asset's absolute address, `sieve://{container}/{key}` |

- **StrokeBasedNote:** `source` is `strokes.jsonl` (§4.1).
- **FileBasedNote:** `source` is the PDF or PNG a producer delivered.
- A committed record is appended to the source first, then sent to an open lens. Points of
  the live feed go to an open lens only and never to the source.
- `note_synced_seq` is the catch-up cursor: replication resumes with `OPEN {noteId, haveSeq =
  note_synced_seq}`.
- `note_device` is copied from the `note-header` and never edited. It says which device a note came
  from; `note_companion` remains the companion's identity on the link.
- One Sieve holds at most one live container per `(note_companion, note_source_id)`.

## 6. Templates

A template is data, never an image: `TemplateRef = {id, params}`, lengths in page units.

| id | params |
|---|---|
| `blank` | none |
| `ruled` | `spacing`, `margin` (optional) |
| `grid` | `spacing` |
| `dots` | `spacing` |

An unknown id is drawn as `blank` and the page is marked "unknown template".

A template is drawn under the strokes, in `#888888`, from these rules. Positions are in the §8 grid
(1404 units across a page), with `round(p · 1404)` for a position p in page units.

- `ruled`: a horizontal line at every y = k·spacing. When `margin` is present and above 0, a vertical
  line at x = margin + k (one per page width). Absent or 0 draws no vertical line.
- `grid`: horizontal and vertical lines at every k·spacing.
- `dots`: a dot at every crossing of (k·spacing, l·spacing).
- A line is 1 grid unit wide, covering c to c + 1 from its position c, across the page's full extent.
  A dot is a disc of radius 3 grid units (2.1368e-3 page units) centred on its position.
- A missing or zero `spacing` draws no marks. k and l are all integers: a fixed page shows those inside
  it, and an unbounded page tiles without end, into negative coordinates, on the plane's own origin,
  so marks never move with the viewer's window.
- A mark is drawn where its extent overlaps what is shown: a line at the far edge of a fixed page lies
  outside it, and a dot centred on an edge is drawn and cut by it.

The companion offers these presets:

| name | id | params |
|---|---|---|
| blank | `blank` | |
| ruled (default) | `ruled` | spacing 0.05, margin 0.12 |
| ruled, no margin | `ruled` | spacing 0.05 |
| narrow | `ruled` | spacing 0.038, margin 0.12 |
| narrow, no margin | `ruled` | spacing 0.038 |
| grid | `grid` | spacing 0.04 |
| dots | `dots` | spacing 0.04 |

## 7. Transport

- **Roles.** Companion = BLE peripheral and GATT server; Sieve = central.
- **Reserved UUIDs.**

  | UUID | |
  |---|---|
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da00` | Sieve ink service, advertised |
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da01` | `psm`: read, u16 little-endian |
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da02` | `identity`: read, UTF-8 |
  | `a378dfef-96d7-4aa8-a37f-3bd6e376da03` | `offer`: read + notify, UTF-8 `library/{catalogue}`, `catalogue` an unsigned decimal |

- **Advertisement.** The advertisement holds the service UUID. The scan response holds service
  data on that UUID: `catalogue` u32 LE. No device name fits the 31-byte legacy limit.
  `catalogue` changes on Sync now, and a scanning Sieve seeing a change should connect at once.
- **Identity.** `identity` is a stable random UUID string minted once per install, and is what
  `note_companion` holds.

- **Channel.** An LE L2CAP connection-oriented channel opened by the companion with the
  *insecure* listener (`listenUsingInsecureL2capChannel`). The PSM is dynamic: Sieve MUST
  read `psm` on every connect and MUST NOT cache it.
- **Link priority.** Once the channel is accepted, the companion MUST open a GATT client
  handle on the same link and request `CONNECTION_PRIORITY_HIGH`. Requested earlier, it is
  overridden.
- **Matching.** Sieve matches a companion by the service UUID, never by its address, which
  is a resolvable private address that changes when the tablet's adapter restarts.
- **Bounds.** Sieve MUST bound its GATT connect on every platform; a stack may never answer.

### 7.1 Pairing and session

- **Key.** 16 RFC 4648 base32 characters, decoding to 10 bytes; whitespace, hyphens and case are
  ignored. It never travels.
- **`sieveId`.** Lowercase hex of the first 8 bytes of `HMAC-SHA256(key, "sieve-id")`. The name a
  Sieve is paired under is a local label.
- **Proofs.** Sieve: `HMAC-SHA256(key, cNonce ‖ "sieve")`. Companion:
  `HMAC-SHA256(key, sNonce ‖ "companion")`. The companion checks Sieve's proof before any ink moves.
- **Session key.** `HKDF-SHA256(salt = cNonce ‖ sNonce, ikm = key, info = "sieve-ink session v1", L = 32)`.
- **Sealing.** ChaCha20-Poly1305 with no AAD. The nonce is direction u32 LE (0 companion→Sieve,
  1 Sieve→companion) then counter u64 LE, starting at 0, one per sealed frame per direction.
- **Framing.** `length u32 LE, payload`: the plaintext frame or ciphertext + tag.
- **Limits.** 256 bytes before proof, 64 KiB from a proved Sieve, 16 MiB + 1 KiB from the
  companion; sealed frames get 16 more for the tag. Over the limit drops the link. A peer has
  10 s to prove, or the link drops. One connection at a time; a second is turned away.

### 7.2 Frames

All integers little-endian. An id is 16 RFC 9562 bytes; a string is u16 + UTF-8; a list is u8
count + strings; a seq is u32, at most 2³¹−1. Everything after `OK` is sealed.

| type | name | direction | fields |
|---|---|---|---|
| 32 | CHALLENGE | C→S, clear | `version` u8 (1), `cNonce` 16 |
| 33 | HELLO | S→C, clear | `sieveId` string, `sNonce` 16, `proof` 32 |
| 34 | OK | C→S, clear | `proof` 32 |
| 35 | REFUSE | C→S | note id (nil if none), `reason` string; clear only answering HELLO |
| 36 | LIST | S→C | |
| 37 | NOTES | C→S | `count` u32, count × (note id, `title` string, `pages` u32, `headSeq` u32) |
| 38 | OPEN | S→C | note id, `haveSeq` u32 |
| 39 | HEAD | C→S | note id, `headSeq` u32, `headHash` 32 |
| 40 | OP | C→S | note id, the record's log frame (§4.4) |
| 41 | ACK | S→C | note id, `seq` u32 |
| 42 | DONE | C→S | note id |
| 43 | META | S→C | note id, `title` string, `keywords` list, `categories` list, `summary` string, `asOfSeq` u32 |
| 44 | OPEN-NOTE | S→C | note id |
| 45 | LIVE | C→S | note id, page id; both nil = no note live |
| 46 | INK | C→S | one or more whole §4.3 records |

`REFUSE` reasons: `refused`, `not-offered`, `ahead` (`haveSeq` is past the head),
`not-foreground`. A companion accepts only `HELLO` before proof, and only `LIST`, `OPEN`, `ACK`,
`META` and `OPEN-NOTE` after it; anything else drops the link.

### 7.3 Behaviour

- The companion sends `CHALLENGE` on accept.
- `LIVE` names the note and page being written, and is sent only for notes this Sieve receives.
  After it names a note, the Sieve sends `OPEN` with its cursor; committed records then keep
  following after `DONE` until the note stops being live, and `OPEN` is needed again next time.
- A Sieve ignores `OP` and `DONE` of a note between sending `OPEN` and receiving its `HEAD` or
  `REFUSE`.
- `NOTES.title` is the log header's title. A title one Sieve gave is never sent to another.
- `META`: title at most 512 bytes, summary 4 KiB, at most 64 terms of 128 bytes. It is dropped if
  the note was not offered on this connection, over limit, past the known head, or the Sieve's
  tick is off. An older `asOfSeq` does not replace a newer one.

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
`{taper: 0, cap: true}`. Filled with its band's tone.

**Tone** is dot density. A chunk's darkness is `min(1, 0.10 + 0.95·p̄^1.3)`; its band is
the first of the keep fractions `0.12, 0.22, 0.34, 0.48, 0.64, 0.82, 0.96` that is ≥ the
darkness (the last band otherwise). Each band is one group filled with one pattern of round
black dots covering that fraction of its area. The tone is geometry, never a filter: a filter
is rasterised at the display's pixel size, so its stipple changes with zoom, while a dot
pattern scales with the page.

```
<pattern id="ink-b{i}" patternUnits="userSpaceOnUse" width="96" height="96">
  <path stroke="#000" stroke-width="1.9" stroke-linecap="round" d="M{x} {y}h0M{x} {y}h0…"/>
</pattern>
```

The tile is 96 grid units square; each dot is a zero-length subpath under a round cap, a disc
of radius 0.95 grid units. Band i (keep fraction k) holds `round(k · 96² / (π · 0.95²) · 1.15)`
dots — the 1.15 makes up the area lost where random dots overlap. Dot positions are drawn in
order, x then y, each `rnd() · 96` written with one decimal, from mulberry32 with state t starting at the seed `1000 + i`:

```
t = (t + 0x6D2B79F5) mod 2³²
z = imul(t ^ (t >>> 15), 1 | t)
z ^= z + imul(z ^ (z >>> 7), 61 | z)
rnd = ((z ^ (z >>> 14)) >>> 0) / 2³²
```

A band whose keep fraction is ≥ 0.96 (the last) is a solid tile:
`<pattern …><rect width="96" height="96"/></pattern>`.

**Document.** In paint order: a white background; group `ruling`, `<g data-ink="ruling">`, holding the
page's template marks (§6); group `pen`; groups `b0`…`b6`, each filled
with pattern `ink-b{i}`; group `live`. Each group is `<g data-ink="{name}">`; `pen` carries
`fill="#000"` and `b{i}` carries `fill="url(#ink-b{i})"`, which every path in it inherits. A
pen stroke is `<path data-stroke="{id}">`; a pencil stroke is, in each band it touches,
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
