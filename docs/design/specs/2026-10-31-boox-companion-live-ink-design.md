# Boox companion and live ink — a pen notebook that replicates into Sieve over Bluetooth

**Status:** Designed
**Tracked:** #204 (epic; per-phase issues are filed as each phase starts)
**Date:** 2026-10-31
**Supersedes nothing.** The folder-sync design (2026-10-29, not committed) remains a valid
second producer of the same Thing, bringing exported files in through a remote folder.
This design takes the cloud out of the path and replaces exported files with live strokes.
§11 states what the two share.

---

## 1. Intent

Handwritten notes made on a Boox Note Air 2 should appear in Sieve as they are written,
on whichever machine is in the room, with no cloud and no network in between. In Sieve the
note is a read-only Thing: an image of the ink, and a clever way to extract data from it.
Nothing in Sieve ever edits the ink.

The user's own words for the moment: *open a note on the Boox, empty or populated, press
Sync, it finds a local Sieve, and if the note's Thing is open in Sieve the current page is
synced live. The canvas is the same on the Boox as it is in Sieve.*

The Boox is a personal device. One of the Sieve instances is a corporate Mac. Ink flows
from the Boox to any paired Sieve; nothing flows back. That is a classification boundary,
not a feature toggle (§2 anti-goals).

## 2. Goals, non-goals, anti-goals

**Goals**

- A minimal notebook app on the Boox ("the companion"): notes, pages, pen, pencil,
  stroke widths, eraser, undo, page templates. Nothing else. Notes live on the Boox and
  work with no Sieve in range.
- Live replication of a note into one or more paired Sieve instances over Bluetooth, with
  catch-up when they were out of range.
- In Sieve, one Thing per note with two read-only views: the page (ink drawn exactly as on
  the Boox, PDF-like page controls) and the reading (AI-extracted prose, diagram blocks and
  PNG cuts), flipped with Mod+Enter.
- Content leaves the Thing by copy, or by "New document from this reading".
- Iteration 2: a rectangular selection on the page that copies a region of ink, or
  mints it as its own Digital Note with a new UUID and its own lifecycle (§8a).

**Non-goals**

- Editing ink in Sieve. Ever.
- Parity with the Boox Notes app (layers, lasso, shapes, handwriting recognition). The user
  does not use them.
- Parsing the Boox `.note` format or hooking the Notes app. Android does not permit either.
- WiFi, USB or cloud transports. Bluetooth is the transport because it assumes nothing
  about the room (corporate WiFi isolates clients; USB tethering on Android 11 needs an
  admin-installed driver on the Mac).
- Building the folder-sync producer. It is not replaced either: a folder-synced PDF or PNG
  is a `FileBasedNote`, another implementation of the same `DigitalNote` interface (§8),
  landing in the same Thing kind and the same lenses. This design keeps that door open and
  builds only `StrokeBasedNote`.

**Anti-goals** (a build that does these has failed even if it works)

- Any path by which content reaches the Boox from a Sieve. The protocol carries sequence
  acks and the pairing handshake from Sieve to companion, and nothing else. There is no
  "two-way" option to leave off.
- The companion displaying anything a Sieve holds. It shows its own notes only.
- Strokes stored as pixels. Strokes are the stored truth on both sides; images are derived.
- Sieve becoming an ongoing writer of any ink log. The one exception is minting a clip
  (§8a): Sieve writes that Thing's log once, at creation, and never again.

## 3. Decision

Three things, one contract between them:

```
 Boox companion (Java, Onyx pen SDK)          Sieve (Go + JS)
 ┌──────────────────────────────┐             ┌──────────────────────────────────┐
 │ notes · pages · op log       │  BLE        │ InkService: scan, pair, replicate │
 │ GATT server + L2CAP server   │ ─────────▶  │ Thing kind "digital note"         │
 │ EPD canvas (raw input)       │  acks only  │ page lens  ⇄ Mod+Enter ⇄  reading │
 └──────────────────────────────┘  ◀────────  └──────────────────────────────────┘
                 shared contract: note model · op log · stroke spec · templates
```

- **One writer, many replicas.** Every pen action is an entry in an append-only, per-note
  operation log with a monotonically increasing sequence number. The Boox is the only
  writer. A Sieve holds a replica and asks for everything after the last sequence it has.
  Live sync and catch-up are the same request.
- **Companion advertises, Sieve scans.** Go's cross-platform Bluetooth support on macOS is
  central-only, and Android's public L2CAP server API exists since Android 10 (the Note
  Air 2 runs Android 11). So the companion is the BLE peripheral: GATT for control, an
  L2CAP connection-oriented channel for the log stream. Sieve is the central on both Linux
  (BlueZ) and macOS (CoreBluetooth).
- **Same canvas = shared stroke spec, not shared code; the SVG is the render.** The
  companion renders natively for the e-ink fast path. In Sieve, the lens renders each page
  of the log to an SVG in JS, shows it, and saves it as the page's asset, the way a Mermaid
  diagram is rendered in the browser and its SVG saved as `svgAsset`; the AI's PNG is
  rasterised from that asset. Go stores and serves and never renders. Two implementations
  of the stroke rule, SieveInk and the lens, pinned to one set of golden fixtures.
- **The Thing is a Digital Note, an interface with implementations.** One new `ThingKind`
  in the Things store #198 D1 builds (`.meta` `type: block`, `kind: digital-note`,
  payload in `{uuid}.block`, folder `blocks/digital-note/`), opened by a full-body lens the
  tab bar selects through `OpenTarget.Kind = block:digital-note`, exactly as #198 does for
  `block:openapi`. `DigitalNote` is what every lens and job sees; `StrokeBasedNote` and
  `FileBasedNote` are the implementations and the only code that knows where pages came
  from. This design builds `StrokeBasedNote`; folder sync would add `FileBasedNote`.

## 4. The companion: SieveInk

A Java Android app, API 30 target, sideloaded. On the Boox it draws through the Onyx
`onyxsdk-pen` `TouchHelper` / `RawInputCallback` path: begin / move / point-list / end for
the pen and the parallel erase callbacks. This is the same low-latency EPD path the Notes
app uses and is why the companion feels like a pen surface rather than a browser canvas.

**The Onyx SDK sits behind one interface and nothing else sees it.** The app is layered so
the vendor dependency is a leaf:

```
 screens · note model · op log · replication · BLE      (plain Android Java, no Onyx)
                     │ uses
              InkSurface  (interface)
                     │ implemented by
   OnyxInkSurface                       AndroidInkSurface
   TouchHelper + EPD fast path          View + MotionEvent + Canvas: any stylus or a finger
```

`InkSurface` is a View that draws the current page from the shared stroke spec and emits
stroke events (begin with tool and width, points with x, y, pressure, time, end, erase
path). The Onyx implementation delegates capture and the fast local echo to `TouchHelper`.
The generic implementation reads `MotionEvent`, which carries pressure on most styluses
and reports a constant mid-pressure for a finger, and draws on an ordinary `Canvas`.
One APK, one release: a factory selects the implementation at runtime (`Build.MANUFACTURER`
is `ONYX` → Onyx surface, otherwise generic), with a manual override in the companion's
settings so the generic surface can be exercised on the Boox. The Onyx SDK is therefore
present but never called on a stock tablet; the first run on a non-Onyx device must confirm
it coexists quietly, and if it does not, Gradle product flavours (a boox APK and a generic
APK) are the fallback. The interface is the companion's own; it must not leak `TouchPoint`
or any other Onyx type.

**Screens**

1. Notes list: title (a user-typed title or the creation time, since notes have no text),
   page count, last modified, a per-note sync indicator. New note. Delete note. **Sync to
   <Sieve>** for the whole list (§4 sync semantics).
2. Page: the canvas with the note's template behind it. Tool bar: pen, pencil, three
   widths, eraser, undo, previous/next page, add page, template picker, **Sync**.
3. Sync: list of paired Sieve instances with a radio to choose the target, "Pair new"
   (enter the Sieve's name and the key shown in its Settings), and an advertising/connected
   status.

**Storage.** One directory per note under app-private storage: `note.json` (header) and
`log.bin` (the op log, append-only). **The companion keeps every record ever written, for
the life of the note.** It never compacts, rewrites or truncates a log: an erased stroke
stays in the log as an add followed by a remove, and the only way a record leaves the
device is deleting the whole note. This is what makes a Sieve that was never in range
equal to one that streamed live: either can ask for the log from seq 1 and get the full
history, erasures and timeline included. Deleting a note on the Boox does not delete
anything in any Sieve; the Thing simply stops receiving.

**Sync semantics.** Consent is **per note, per Sieve, remembered**: the first time a note
is sent to a Sieve is a deliberate act on the Boox, and the companion records the pair.
Nothing lands on a Sieve a note was never consented to. There are two Sync buttons and one
mechanism:

- **In a note: Sync.** Advertises with this note's id, serves the selected Sieve's catch-up
  for it from the sequence it asks for, then keeps streaming live as ink is written. First
  use records the consent. Advertising stops when the user leaves the note or presses Sync
  again.
- **On the notes list: Sync to <Sieve>.** Advertises a *library* offer. The Sieve lists the
  notes, and the companion serves catch-up for every note already consented to that Sieve,
  one after another over the same connection. Notes not yet consented are shown on the
  Boox as a tick list; ticking one records consent and includes it. This is how a **new
  Sieve receives an existing library** in one sitting, and how the corporate Mac receives
  only what is ticked. Nothing is live here; it ends with a summary and stops advertising.

In both cases the companion is in the foreground and needs no background service; a note
edited out of range catches up at the next Sync of either kind. Target selection on the
Sync screen names the Sieve; a connecting Sieve must prove it holds that pairing's key
(§6) and any other Sieve, paired or not, is refused. The companion never blocks on a
Sieve: ink is written to the local log first and streamed second. Background sync with no
user present is not in this design.

**Distribution.** SieveInk is published through the architect's own app centre
(`stephen/appcentre` on the forge), not by cable. The contract is a directory per app under
the app-centre root, `/mnt/media/app_centre/SieveInk/`, holding `SieveInk.apk`, `app.png`,
`release_date` (a `YYYYMMDD-HHMM` stamp), an `old/` archive of previous builds and a
`release_in_progress` marker while a copy is under way; the collective app on each device
installs from it. SieveInk's `release.sh` does what `toastie_app/release.sh` does, with a
Gradle `assembleRelease` in place of `flutter build apk`. Phase 2 ends with the first build
published this way and installed on the Note Air 2 from the collective app.

**Language choice.** Java, by the architect's preference; the Onyx SDK is a Java library
and Android supports Java apps fully. Flutter was considered and deferred: the one Dart package
(`onyxsdk_pen`, Saber's extract) is a stripped-down accelerator widget that exposes no
stroke callbacks, pressure or erase events and is maintained best-effort without a device,
and `TouchHelper` binds to a native Android View, so under Flutter the canvas would still
be this same Java `InkSurface` hosted in a platform view, with Dart owning only the chrome. That remains possible later precisely because the surface is behind
an interface, but it adds a second language for the easy half of the app. Go via gomobile
cannot reach the SDK.

## 5. The shared contract

This section is the interface between the two repositories. It is written here because
Sieve is the consumer and the longer-lived of the two. Both sides vendor the golden
fixtures.

### 5.1 Note model

```
Note
  id          UUIDv7, minted by the companion at creation (ident.New semantics)
  created     RFC 3339
  title       string, user-typed, may be empty
  pageAspect  width/height ratio of a page (Note Air 2 portrait = 1404/1872)
  template    TemplateRef, the note default (§5.4)
  pages       ordered list of Page
Page
  id          UUIDv7
  template    TemplateRef | null (null = inherit note default)
  strokes     ordered list of Stroke, derived by replaying the log
```

Pages and strokes are never edited in place in the model; the log is the truth and the
model is a replay of it. That is what makes a replica trivially correct.

### 5.2 Operation log

Binary, length-prefixed records, each `seq` exactly one greater than the previous.

| op | payload | notes |
|---|---|---|
| `note-header` | the Note header fields | always `seq 1`; re-emitted on title/template/aspect change with a new seq |
| `page-add` | pageId, index, template | |
| `page-remove` | pageId | strokes on it become unreachable, not deleted |
| `page-template` | pageId, TemplateRef | |
| `stroke-add` | pageId, Stroke | |
| `stroke-remove` | pageId, strokeId | the eraser and undo are both this |

Rules that make the log a frozen contract:

- The eraser removes **whole strokes**: touching any point of a stroke emits one
  `stroke-remove`. There is no partial erasure and no `stroke-edit`. (Onyx's erase
  callbacks deliver a path; the companion intersects it with strokes and removes those.)
- Undo of a `stroke-remove` is a `stroke-add` with the **same stroke id** and points.
  Re-adding an id that is currently present is a no-op; removing an unknown or absent id
  is a no-op. So a replica that missed records still converges on replay.
- Undo of a `page-remove` is a `page-add` with the same page id and index. Pages are
  never reordered in this design; a `page-move` op is a contract bump.
- The log is never compacted or rewritten by either side. A replica that holds seq 1..N
  holds the complete history to N, on every machine, whether it streamed live or caught up
  later.
- Undo is an op like any other, never a rewind of the log. The reading-cache hash (§8)
  is over the page's *current* stroke set, so remove-then-undo hashes back to the same
  value and hits the cache.

### 5.3 Stroke spec

```
Stroke
  id        UUIDv7
  tool      pen | pencil            (extensible: marker, highlighter)
  width     1 | 2 | 3               (nominal width class; the renderer maps to units)
  start     milliseconds since the note's creation, uint32 (when the stroke was made;
            cheap to carry, informational, nothing depends on it)
  points    [Point…]
Point
  x, y      normalised page coordinates: x in [0,1] across the page width,
            y in [0, 1/pageAspect] down the page height, so a page is square-pixel
  p         pressure 0..1
  t         milliseconds since stroke start, uint16
```

**Rendering rules** (normative, with golden fixtures):

- Points are smoothed with Catmull–Rom into a path; the companion may draw raw points
  live on the EPD for latency and re-render on pen-up.
- **Pen**: stroke width = `base(width) × (0.6 + 0.8·p)`, round caps and joins, opaque ink
  colour from the theme.
- **Pencil**: width `base(width) × (0.7 + 0.6·p)`, opacity `0.35 + 0.55·p`, with a
  deterministic stipple derived from the stroke id as the seed, so both sides draw the same
  grain. Width carries pressure because e-ink shows few grey levels and opacity alone was
  invisible on the Note Air 2. Pencil is a rule, never a bitmap texture.
- `base(1..3)` in page units is fixed in the spec, not per device, so the Boox and a
  4K monitor agree.

### 5.4 Templates

A template is data, never an image. `TemplateRef = { id, params }` from a small versioned
catalogue both sides carry: `blank`, `ruled {spacing, margin}`, `grid {spacing}`,
`dots {spacing}`. Unknown id → draw `blank` and mark the page "unknown template" in the
lens. Adding a template is a contract bump on both sides.

### 5.5 Golden fixtures

A fixtures directory holds `{name}.log` + `{name}.svg` pairs. The stroke rule has exactly
two implementations, SieveInk's (Android Canvas, for the e-ink) and the lens's (JS,
producing the SVG). Both expose the rule as a pure geometry function (stroke → vertices,
widths, alphas, grain dots) and both emit that geometry as SVG, so parity is checked as a
**text diff of SVG**, byte for byte, in each side's unit tests; SieveInk's debug Export
writes a real page as JSON plus its own SVG, which is the same check over real
handwriting. This is how "same canvas" is kept true over time.

## 6. Transport

**Standards.** The transport uses two Bluetooth Core Specification protocols and nothing
vendor-specific: GATT (Core 4.0) for control and LE L2CAP connection-oriented channels
with credit-based flow control (Core 4.1) for the stream. The custom part is the service
and characteristic UUIDs and our payload, which is how every BLE product uses GATT. Both
protocols are exposed by BlueZ on Linux, CoreBluetooth on macOS (L2CAP since 10.14) and
Android's public API (L2CAP since API 29). Bluetooth Classic profiles (RFCOMM, OBEX) are
excluded because CoreBluetooth does not carry Classic. The SIG Object Transfer Service is
the nearest standard profile; its shape (an object read by offset, a changed indication)
is borrowed, but conformance is not claimed because OTS needs a fixed PSM that Android's
`listenUsingL2capChannel` cannot bind.

**Roles.** Companion = BLE peripheral and GATT server. Sieve = central. One Sieve service
UUID is reserved for discovery.

**GATT control service** (small, infrequent):

| characteristic | direction | purpose |
|---|---|---|
| `identity` | read | companion id, protocol version, catalogue version |
| `offer` | read + notify | what is being offered: one note's UUID, or `library` |
| `psm` | read | the L2CAP PSM the companion is listening on |

**L2CAP connection-oriented channel** carries the replication protocol (§7). It is a byte
stream with real throughput, which GATT notifications are not. Android exposes it as
`BluetoothAdapter.listenUsingL2capChannel()` (public since API 29). BlueZ exposes it as an
`AF_BLUETOOTH` / `BTPROTO_L2CAP` socket over LE, reachable from Go without cgo.
CoreBluetooth exposes it as `CBPeripheral.openL2CAPChannel(psm)`; the Go library in use
does not wrap it, so the Mac needs a small Objective-C bridge. **That bridge is the spike
that must pass before anything else is built** (§10).

**Pairing and trust.** Pairing is a **pre-shared key**, chosen over a PAKE and over OS
pairing because it is the simplest scheme that is actually sound, uses only standard
library primitives on both sides (HMAC-SHA256, HKDF, ChaCha20-Poly1305: Go's `crypto`
packages, Android's `javax.crypto` since API 28), and has nothing clever in it to get
wrong. Each Sieve instance generates an 80-bit key on first run, shown in Settings → Ink
as 16 base32 characters in groups of four next to the instance's name; the user types it
once into the companion under "Pair new", against that Sieve's name. The key never travels
over the air:

- **Mutual proof of possession.** Each side sends a 128-bit nonce; the other answers with
  `HMAC-SHA256(key, nonce ‖ role)`. The companion checks Sieve's answer *before* any ink is
  sent, which is the direction that protects the notes; Sieve checks the companion's so a
  rogue peripheral cannot feed it a fake log. A recorded exchange is useless against a
  fresh nonce.
- **Encrypted stream.** There is no OS pairing, so there is no link encryption to rely on.
  Both sides derive a session key with HKDF from the pre-shared key and both nonces and
  wrap every frame on the L2CAP channel in ChaCha20-Poly1305 with a per-direction counter
  as nonce. This is the Noise framework's PSK pattern done by hand; a builder may use a
  Noise library on both sides instead and the contract is unchanged in effect.
- **Key rotation** is "generate a new key in Sieve, type it into the companion again".
  There is no revocation protocol; deleting the pairing on either side is enough.

LE link encryption is additionally requested where the stack offers it but nothing depends
on it. There is no `pair` GATT characteristic; pairing is data entry on the Boox.

**What this does and does not protect, stated so nobody mistakes it for more.** It stops a
device in radio range from reading ink off the air, from impersonating a Sieve to receive
notes, and from replaying a recorded handshake; 80 bits makes offline guessing against a
recorded exchange infeasible. It does not hide that a sync is happening: the advertisement
and the note's UUID in its service data are visible to anyone scanning, which is metadata
and accepted. It does not protect against a compromised desktop or Boox, and a key typed
into the wrong device is a key given away. The threat model is modest on purpose, a
personal notebook used mostly at home and sometimes in shared rooms, and the design is
sized to that: credible, not elaborate. If a shorter PIN is ever wanted, SPAKE2 at pairing
time is the drop-in that keeps everything downstream unchanged; a short PIN used directly
with this handshake would be brute-forceable offline and is excluded.

**Sieve-side scanning.** `InkService` scans while the app runs and at least one pairing
exists, filtering on the Sieve service UUID. Scanning is passive and cheap; it is not a
user action. Settings → Ink shows this instance's key and name and lists the companions that have connected.

## 7. Replication protocol

Over the L2CAP stream, framed, Sieve speaks first.

```
companion → Sieve   CHALLENGE {cNonce}
Sieve → companion   HELLO   {sieveId, sNonce, proof}      proof = HMAC(key, cNonce ‖ "sieve")
companion → Sieve   OK      {proof}                      | REFUSE {reason}   proof = HMAC(key, sNonce ‖ "companion")
            — session key derived; every frame below is encrypted —
Sieve → companion   LIST                                   (library offer only)
companion → Sieve   NOTES   [{noteId, title, pages, headSeq}…]   consented notes only
Sieve → companion   OPEN    {noteId, haveSeq}                 once per note it wants
companion → Sieve   HEAD    {noteId, headSeq, headHash} | REFUSE {reason}
companion → Sieve   OP*     log records from haveSeq+1; in a note offer, then live as written
Sieve → companion   ACK     {seq}  every N records or 500 ms, whichever first
companion → Sieve   DONE    {noteId}   end of catch-up for this note (library offer);
                                       Sieve may OPEN the next
```

A note offer serves exactly one `OPEN`, for the offered note, and the stream stays open
for live ink. A library offer serves any number of `OPEN`s in sequence, each ending in
`DONE`; Sieve opens every listed note whose `headSeq` exceeds its own `haveSeq`, so an
unchanged note costs one line of `NOTES` and nothing more.

- `haveSeq = 0` means "I have never seen this note": full replay.
- The companion may stream ahead of acks; acks exist so the companion can show "synced to
  seq N" and so a dropped connection resumes from the right place.
- Nothing else travels Sieve → companion. A frame that is not `HELLO`, `LIST`, `OPEN` or
  `ACK` is a protocol error and the companion disconnects. `LIST` carries no selector:
  what is listed is decided on the Boox by consent, never requested by the Sieve. The handshake frames carry no note
  content, so the one-way rule holds.
- Only the selected target is served per Sync. Each Sieve keeps its own `haveSeq` per
  note; the companion's only per-Sieve state is the pairing and the set of notes consented
  to it.

### 7.1 Loss and reconciliation

The channel is a reliable, ordered byte stream: LE CoC credit-based flow control is
back-pressure, and the link layer retransmits beneath it. Nothing is best-effort, so loss
only ever appears as a dropped connection. The replica still never trusts that:

- **Contiguity.** Every record's `seq` must be exactly `last + 1`. A gap or a repeat is a
  protocol error: Sieve discards the record, drops the connection and reconnects with
  `haveSeq` = its last contiguous seq. The companion resends from there. Records are
  appended to the replica only after this check, so the on-disk replica is contiguous by
  construction.
- **Record integrity.** Each record carries a CRC32 over its body, checked on receipt and
  on every replay from disk. A corrupt record on disk truncates the replica to the record
  before it and the next Sync fills in from there.
- **Fill in the blanks.** `HEAD` carries `headSeq` and `headHash`, a hash chain over the log
  (`h(n) = H(h(n-1) ‖ record(n))`). Sieve computes the same chain as it appends. After
  catch-up, if its `h(headSeq)` differs from the companion's, the replica is wrong in a way
  contiguity could not see; Sieve renames it aside and asks again with `haveSeq = 0`. Logs
  are small, hundreds of kilobytes for a long notebook, so a full replay is the reconcile
  path, and there is no merge. The mismatch is surfaced in the Sieve log, not hidden.
- **Acks are not the loss mechanism.** They tell the companion what to show as "synced to
  seq N" and where a resume will start; correctness never depends on them.

## 8. The Thing in Sieve

**The Digital Note and its implementations.** `DigitalNote` is the Go interface every lens
and job talks to; the kind of note is the implementation behind it. (Names are working
names, to be improved by the builder.)

```
DigitalNote                         what every consumer sees
  ID() uuid · Title() string · PageCount() int
  Render(page, dpi int) (png []byte, error)   // what the reading job and copy need
  PageKey(page int) string                    // reading-cache key for the page

VectorNote                          DigitalNote + Strokes(page int) []Stroke
                                    the page lens and the clip tool type-assert for it

StrokeBasedNote   implements VectorNote: pages are a replay of the block's op log (§5)
FileBasedNote     implements DigitalNote: pages are a PDF's pages or one image each
```

| implementation | pages from | `PageKey` | lens draws | live | clip yields |
|---|---|---|---|---|---|
| `StrokeBasedNote` | replaying the op log in the block | hash of the page's stroke set | the SVG the lens rendered from the log, saved as an asset | yes | a stroke set → a `StrokeBasedNote` clip |
| `FileBasedNote` | a synced PDF, or PNG/JPG pages (future; also raster clips) | hash of the page's bytes | a bitmap | no | a bitmap → a `FileBasedNote` clip |

The reading view, the AI job, the cache, Mod+Enter, copy and "New document from this
reading" use `DigitalNote` only and never learn which implementation they are over. The
page lens and the clip tool use `VectorNote` when the Thing offers it and fall back to
bitmaps when it does not. `.meta` records the implementation beside the type, and a factory
on the load path constructs the right one, as processors are looked up by kind today. This
design builds `StrokeBasedNote`; `FileBasedNote` is where folder sync and a PDF rasteriser
would enter, scoped to that implementation and that future work.

**Storage.** A Thing is a Sieve block stored in its own directory with a `.meta`, as #198
D1 defines it: `type: block`, `kind: digital-note`, the bare payload in `{uuid}.block`,
snapshots as `{uuid}.{n}.block`. There is **one kind**, not one per implementation: the
payload's shape (an op log, or a `src` asset address) says which implementation the
`DigitalNoteKind` constructs on load, so the sidebar has one `blocks/digital-note/` folder
and the lens table one entry. The two implementations differ only in where the block's
content lives:

- **`StrokeBasedNote`:** the block's source *is* the note. Its YAML payload holds the note
  header and the operation log as an array of records, in the shared contract's shape
  (§5.2), so the file is readable and diffable and the block is self-contained.
- **`FileBasedNote`:** the block's `src` is an **asset** that sits beside it in the same
  directory, addressed absolutely as `sieve://{thing}/{key}` like every asset-bearing attr.
  The block carries title, provenance and reading state; the asset carries the pages. The
  two change independently: a producer replacing the PDF touches the asset and not the
  block, and `PageKey` is the hash of the asset's page, so a changed asset simply misses
  the reading cache and a changed block does not.

In both cases the per-page reading cache lives in the Thing's directory keyed by `PageKey`.
`InkService` appends records to the `StrokeBasedNote` block as they arrive whether or not
the Thing is open; the open lens is a follower, not the owner. Appends are debounced
(the in-memory replica is written through on a short timer and on disconnect) so a live
pen does not rewrite a YAML file per stroke; the hash chain (§7.1) makes a crash between
writes a resumable gap, not corruption. The wire format (§7) and the companion's own
on-device log are independent of this storage; only the record *shape* is shared.

**Identity.** The Thing's uuid is Sieve's, minted by `ident.New` like every id, and the
companion's note id is held as a **property**, `note_source_id`, beside `note_companion`
in the face. The two are deliberately not the same id: the replica on each machine
diverges from the others and from the Boox the moment it has its own reading cache, its
own clips and its own lifecycle, so they are different things that share a source, not one
thing in several places. "The document travels with a UUID and Sieve matches it" is
therefore a lookup over `(note_companion, note_source_id)` in the Things store, with the
rule that one Sieve holds at most one live Thing per source note; a forgotten note that is
synced again gets a fresh Thing with the same `note_source_id`. Stroke ids inside the log
stay the companion's: they are payload records, not Sieve ids, and nothing outside the log
addresses them.

**Face.** As #198 computes `spec_title` and friends in Go on save, `DigitalNoteKind.Face`
yields `note_title`, `note_pages`, `note_source` (`strokes` | `file`), `note_source_id`,
`note_companion` and `note_synced_seq` into `.meta`. The sidebar, the reference card and any triage read the
face and never the body.

**Snapshots.** A live pen would make a version per debounced write. The replica path
snapshots once per sync session, on disconnect, not per write. My call; the builder may
pick a different cadence, but never per record.

**Live path to an open lens.** Initial load is whole-content through the Thing load
endpoint #198 D2 adds, and the lens replays the log in JS. While a sync is running the
lens must learn of new records without refetching a growing YAML every tick: `InkService`
pushes appended records to the open lens over the DOCUMENT wire's per-uuid channel as a
new frame in `sieve/protocol`, and the lens applies them to its replay. A `things`
invalidate topic (#198 D2) still fires on disconnect so closed views catch up on open.

**Reference card.** A note that `@`-mentions a Digital Note gets the existing reference
card stamped from the `ThingsSource` face: title, `"{n} pages"`, last synced. Opening it
activates the Thing's tab. No new block kind, as in #198 D4.

**Lifecycle, per kind.** #198 makes lifecycle a property of the `ThingKind`: an OpenAPI
Thing is born Isolated in `WorkingCopy` and published to `Things` at close-time triage.
`DigitalNoteKind` declares a different one. A synced note is **born published**, created
directly in the Shared `Things` category under `blocks/digital-note/`: the user's deliberate
act of choosing this Sieve on the Boox *is* the keep decision, and there is nothing to
triage in a body the user cannot edit. A **clip** (§8a) is made in Sieve, so it follows the
default: born Isolated in `WorkingCopy`, published to `Things` or discarded at close, with
triage fed the face (title, pages, provenance), never the body. `user_intent` stays
user-owned in both cases. My call, and the one place this design deliberately differs
from #198's lifecycle; it does so through the mechanism #198 provides, not around it.

**The lens.** `DigitalNoteLens extends AbstractEditor` (#199 is merged: a lens declares
its own mode repertoire and imports no ProseMirror), with modes `page` and `reading`,
`modEnterTogglesMode` flipping between them, and **no `blocks` capability**, so Ask,
Explain, the insert dialogs, attach and asset insert ignore it by construction, as
`ApiSpecLens` does. It is registered in the one lens table #198 D2 creates, keyed by the
kind the tab bar carries: `'block:digital-note': DigitalNoteLens`. Unlike `ApiSpecLens` it
has no source face and therefore no dependency on the source editor or #71.

**View one — the page.** The `page` mode, PM-free, mounted where the editor would be. The
lens renders the page's strokes to one SVG in JS (template as a background group, then one
`<path>` per stroke carrying the stroke id and its sequence number, pencil grain as a group
of circles) and saves that SVG as the page's asset keyed by the page's stroke hash, exactly
as a Mermaid diagram is rendered in the browser and saved as its `svgAsset`. Chrome: page
`n / N`, previous, next, jump, zoom to fit / 100%. Live: as records arrive for the displayed
page over the document wire, the lens renders the new stroke's `<path>` and appends it (or
removes an erased one); the whole SVG is never replaced while ink is arriving. A page
indicator shows which pages have unseen ink. Read-only is structural: the lens has no verbs
that produce ops.

**Mod+Enter — the flip.** The lens's mode repertoire, the same mechanism `ApiSpecLens`
uses for `rendered`/`source`. `page` ⇄ `reading` for the current page.

**View two — the reading.** The `reading` mode. Per page, Sieve hashes the page's current stroke set (ids and
points, not pixels). Cache hit → show the stored reading. Miss → the page's saved SVG asset is
rasterised to PNG, submitted through the AI subsystem as a job, and the result stored under
the hash. Reading is a lens verb, so the Thing is open and the asset exists when it is asked
for. The reading is a list of blocks: prose, PlantUML diagram blocks
validated in Go through the existing PlantUML service (one retry with the render error,
then fall back to a PNG cut), and PNG cuts for regions the model cannot decipher.
Mermaid is excluded from readings in this design because it renders only in the browser
and the job runs in Go; adding it means validating at first browser render and is a later
extension. Nothing is
dropped. Shown read-only with the same page controls; Mod+Enter flips back. A re-read
button forces a miss.

**Replay (an easter egg, not a requirement).** The log is a recording, so the page view can
have a Replay control: iterate the page's ops in order, drawing each stroke point by point
on its own `t` timeline, so a sharp flick lands in a few frames and a lazy pull unrolls
slowly (the digitiser samples at 100–200 Hz and `t` is in milliseconds, which is ample).
Between strokes the real gap from `start` is used, clamped to about a quarter of a second,
so the rhythm between letters and words stays real while a coffee break becomes a beat.
The animation is fun, not provenance, and it is cheap because every stroke is its own
`<path>` and the lens holds the strokes it rendered them from: it reveals paths in sequence
order and animates each with the standard dash trick (`stroke-dasharray` equal to the path
length, `stroke-dashoffset` driven by elapsed time mapped through the points' `t`); pencil
grain circles appear with their stroke.
The same fact gives a **timeline**: a scrubber over seq N shows or hides elements whose
sequence is at or below N, erasures included, with no re-rendering at all. Desktop only;
the companion needs neither. Erasures replay as
erasures, so the page un-draws where it was corrected. It is the same renderer driven by a
clock instead of all at once; a file-based note has no log and no Replay. Build it last, if
at all.

**Getting content out.** Copy from either view (a page copies as PNG; reading blocks copy
as blocks). "New document from this reading" mints an ordinary markdown document in the
scratchpad from the reading's blocks with fresh ids, as every paste does. The Thing is
untouched and holds no link to the new document.

**What a Thing never has.** A caret, an editor, a save path, a user_intent, a filing
decision.

## 8a. Selection and clips (iteration 2)

**Selection.** View one gains one tool: a rectangular selector (a lasso may follow; the
rectangle is enough and far easier on both sides). Dragging a rectangle selects every
stroke with at least one point inside it. Whole strokes, never cut strokes, so the result
is still a valid stroke set. The selection is lens state, not an op; nothing is written.

**Copy.** Copies the selection as a PNG rasterised from the lens's SVG of the selected
strokes, plus an `application/x-sieve-ink` payload holding the selected strokes re-based to
the selection's bounding box. Pasting into a markdown document yields a smart-image block
from the PNG today; a future ink block kind could consume the stroke payload instead.

**Extract as Thing.** Mints a new Digital Note, the clip. Over a `VectorNote` it is a
`StrokeBasedNote` as described below; over anything else it is a `FileBasedNote` holding
the cropped PNG, with the same provenance record. The rest of this section is the vector
case:

- New uuid from `ident.New` like every Thing, and no `note_source_id`: nothing ever
  arrives for it; it is complete the moment it is made.
- Its log is synthesised by Sieve once: `note-header` (title defaults to
  "Clip from {source title} p.{n}", `pageAspect` = the selection's aspect, template =
  `blank`), one `page-add`, then a `stroke-add` per selected stroke with points re-based
  to the selection box and the **original stroke ids kept**. Keeping the ids is what lets a
  later feature say "this clip came from these strokes".
- `.meta` carries provenance as data: the source Thing's uuid, its `note_source_id`, page
  id, rectangle, and the source `headSeq` at clip time. It is a record, not a link: the clip does not follow the source,
  and deleting either leaves the other intact.
- From then on it is an ordinary Digital Note: both views, Mod+Enter, its own reading cache,
  its own "New document from this reading", and its own clips. Reading a clip in
  isolation is the point: the AI sees only the fragment, not the page.

This is why the log, not the page image, had to be the stored truth: a clip is a
projection of the log, and a clip of a clip is the same operation again.

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| No Sieve in range | Companion writes locally; indicator shows "not synced since seq N"; the next Sync of either kind catches up |
| New Sieve, existing library | Pair, then **Sync to <Sieve>** on the notes list; tick the notes to consent; all catch up from seq 1 |
| Connection drops mid-stream | Sieve reconnects on next advertisement with its `haveSeq`; companion resumes |
| Proof mismatch | Companion refuses, shows "unknown Sieve"; Sieve shows "key rejected, re-enter the key on the Boox" |
| Unknown op or template version | Replica stores the raw record, lens shows the page with a version warning; a Sieve upgrade replays |
| AI read fails | Reading view shows the page PNG with a failed badge and retry; page view unaffected |
| Diagram won't render after retry | That region becomes a PNG cut |
| Companion deletes the note | Nothing happens in Sieve; the Thing is a snapshot from here on |
| Sieve forgets the Thing, companion syncs the note again | A fresh Thing with the same `note_source_id`, replayed from seq 1 |

## 9a. Coherence with #198 and what this epic depends on

This design rides the Things store and lens-by-kind mechanism that #198 defines; it adds
a second `ThingKind` and a second lens and invents no parallel mechanism. Concretely:

| #198 dispatch | What it provides here | Status |
|---|---|---|
| D1 Things store (headless Go) | `.meta type: block`, `{uuid}.block`, `Things` category, `ThingService`, `ThingKind` registry, `ThingsSource` on the Router, `OpenTarget.Kind` | Unblocked in #198; **phase 3 here needs it**, unchanged |
| D2 wire + mount | Thing load/save endpoints, `WholeContentAdapter` serving a Thing, the lens table keyed by kind, tab bar carrying kind, the `things` invalidate topic, the interaction-contract entry for lens modes | #198 says blocked on #71 and the source editor, **but only its source face is**; the wire-and-mount half is separable and this lens needs only that half. **Phase 4 here needs it**, and could be the pathfinder that lands it |
| D2 `ApiSpecLens` modes via `AbstractEditor` | the lens-level Mod+Enter flip | #199 merged; the repertoire mechanism exists, the contract-doc entry lands with whichever lens ships first |
| D4 reference card from the face | `@`-mention card for a Digital Note | reused as is |

Where the two designs differ, and why it is coherent: lifecycle (born published vs born
Isolated) is per kind by #198's own rule; one kind with two implementations rather than
one kind per face is a choice inside this kind. The sidebar's new-tab chooser (#198 D2)
does not list Digital Notes: they are born from a companion or from a clip, never from a
blank tab.

## 10. Phasing

Each phase is a Forgejo issue under one epic; the companion has its own repository and
its own issues, referencing the contract by section.

0. **Spikes (throwaway, #205).** Two, independent. **A, the pen surface, first:** a bare
   Onyx raw-input canvas on the Note Air 2, judged by hand against the Notes app, with
   sample rate and pressure measured. **B, the stream:** Sieve on Linux and **on the actual corporate Mac** opens an
   L2CAP channel to a stock Android 11 device running a 50-line Java app and moves 1 MB.
   Measure throughput and connection time. The Mac run also proves the Bluetooth privacy
   prompt (`NSBluetoothAlwaysUsageDescription` in the Wails `Info.plist`) is granted to the
   build as it is actually installed there; device management, not CoreBluetooth, is the
   risk. If the Mac bridge is not viable, fall back to GATT notifications for the log
   (slower, still correct) and say so here.
1. **Contract:** §5 as a `docs/` document plus the golden fixtures and the JS stroke
   renderer (log → SVG) that produces them, checked against SieveInk's SVG emission by text
   diff. Tests only; no UI.
2. **Companion v1:** notes, pages, pen/pencil/widths/eraser/undo, templates, local log,
   Sync button, GATT + L2CAP server, pairing by key. `InkSurface` with both
   implementations and runtime selection; the generic surface is how the app is developed
   and tested on an emulator or any tablet. Renders the fixtures in its tests. Ships
   through the app centre (§4 Distribution) and is installed from the collective app.
3. **Sieve replication:** `InkService` (scan, pair, HELLO/ACK, append to the replica),
   `DigitalNoteKind` with `StrokeBasedNote` and its face, Settings → Ink. **Depends on #198
   D1.** The page can be inspected only via the fixtures and a debug dump at this point.
4. **Page lens:** `DigitalNoteLens` in `page` mode, live repaint over the document wire,
   page chrome. **Depends on #198 D2's wire-and-mount half**, which this phase lands if
   #198 has not.
5. **Reading lens:** hashing, cache, AI job, view two, Mod+Enter, re-read, copy, New
   document.
6. **Iteration 2 — selection and clips (§8a):** rectangle selector, copy as PNG + ink
   payload, Extract as Thing with provenance in `.meta`.

## 11. Relationship to the folder-sync design

The folder-sync design becomes a second **producer** of the same Thing, not an alternative
to it, and the library offer (§7) shows the two are the same shape: that design's Source
was `List`, `Open` and `Changes` over files; this one's is `LIST`, `OPEN` and a stream over
logs. A WebDAV source yields `FileBasedNote`s where the companion yields
`StrokeBasedNote`s, and both are "a folder of notes arriving", so a Sieve-side `Source`
abstraction with those two implementations is the natural home when the second one is
built. Its Source interface writes a `FileBasedNote` into the same Shared category, and the same two lenses, the same reading job and the same clip
tool apply with the bitmap fallbacks in §8. What it would add is `FileBasedNote` and a PDF
rasteriser for it; what it would reuse is everything else here. Its open questions 2 (a PDF
rasteriser that ships without admin rights) and 5 (pixel-hash stability) belong to
`FileBasedNote` alone and do not arise for `StrokeBasedNote`, which owns its strokes and
hashes them exactly.

## 12. Left to the builder

- Binary framing of the companion's on-device log and of the L2CAP frames (CBOR or a hand-rolled TLV; pick
  one and write it into the §5 contract document).
- GATT UUID values, PSM allocation, advertisement layout.
- The Catmull–Rom tension and `base(width)` constants, settled when the fixtures are made.
- Exact layout and iconography of the companion and the lens chrome; the look follows the
  Sieve theme tokens on the Sieve side and e-ink legibility on the Boox side.
- The AI prompt and the JSON shape of a reading; follow the ai-block conventions.
- How `InkService` is wired into `ServiceProvider` and which package owns the BLE code.

## 13. Open questions for the architect

The companion is **SieveInk**, in its own repository. The epic hinges on two things, and
phase 0 (#205) tests both before anything is built: technically, will the stream work; and
how usable will SieveInk be under the nib.

1. For a clip, should the selected strokes be re-based to the rectangle (default) or keep
   page coordinates with the rectangle as a viewport?
2. Does the corporate Mac get the AI reading at all, given it sends page images to the
   corporate provider? Default: yes, per instance, same as every other AI job there.
