# UAT log — epic #204, Boox companion and live ink

What needs a person, a pen or a Mac before `epic/204` is squashed. Each item says what to do and
what should be seen. An item is added when the code for it lands on the branch and ticked when it
has been done by hand. This file is removed at the squash.

Run the branch build against a store of its own. Quit the installed Sieve first: the app holds a
single-instance lock.

```
cd .claude/worktrees/epic-204 && nix develop -c wails build
T=$(mktemp -d)
XDG_CONFIG_HOME=$T/config XDG_STATE_HOME=$T/state build/bin/sieve $T/library
```

The log is `$T/state/sieve/sieve.log`; on a Mac, `~/Library/Logs/Sieve/sieve.log`. Settings →
Editor → Enable Debug Mode shows the radio's found and connected lines.

## Phase 3 — replication (#210)

- [x] **Linux: pair, sync, write, resume, switch off.** Done 2026-11-05 at `ac1688fb`: 123 records,
  831 kB in 30.6 s, 27.2 kB/s, 4.2 s to connect; Bluetooth off and on at the tablet resumed the
  log; the toggle off closed the link.
- [ ] **SieveInk with the 4096-byte SDU cap and no keep-screen-on** (SieveInk `b316fce`).
  - Write a long stroke (a slow scribble of several seconds, or heavy pencil shading) with Sieve
    connected: Link stays "Connected", no "authentication failed", and the note's seq advances.
  - Leave a note open on the Boox and walk away: the tablet sleeps on its own timeout and the
    front light goes off.
- [ ] **Wrong key.** Settings → Ink → New key, without re-pairing: Link reads "key rejected —
  re-enter the key on the Boox", the redial slows down instead of repeating every second, nothing
  on disk changes. Re-pair with the new key and it connects.
- [ ] **Throughput.** Catch-up ran at 27 kB/s against the spike's 63–75 kB/s. With a library of a
  few hundred kB, note Settings → Ink → Last Session → Throughput on a fresh sync. Fine for a pen;
  wanted before the Mac's number is compared with it.
- [ ] **The corporate Mac.** Install the `macos` artifact of the GitHub `Release (macOS)` run for
  the newest `mac-test-*` tag (Actions tab; such a tag publishes no release). The tablet must be on
  the SDU-cap SieveInk build first.
  - Settings → Ink → tick the toggle. macOS should ask whether Sieve may use Bluetooth; allow it.
    No prompt and Link reading "…not authorised to use Bluetooth…" means device management has
    refused it: stop and send the log. "Bluetooth is off": turn it on, it recovers by itself.
  - Pair, sync, write live, and drop and resume, as on Linux. Write down Time to connect and
    Throughput beside Linux's.
  - If anything fails, send the Link line as shown and the log from the first
    `ink bluetooth manager created` line. Each failure names its step: `gatt connect`,
    `discover service`, `read psm`, `open l2cap channel psm=…`, `open l2cap streams`,
    `l2cap read: nothing received for 10s`.

## Phase 4 — the lens and Live (#211)

With Ink enabled, the sidebar has an **Ink** section under Library: **Live** while the tablet is
writing, then the synced notes. Live is SieveInk's own view, whichever note that is; a note's own
tab is the reader's.

### A note's own tab

- [ ] **A synced page looks like the page.** Open a note with pen and pencil on a ruled page from
  the Ink section. The sheet is white whatever the theme, the ruling sits under the ink, pen
  strokes are solid and pencil strokes are grained, and it is recognisably what the tablet shows.
  Fit width ⇄ 100% both read well; PageUp and PageDown turn pages.
- [ ] **It is the reader's.** With the note open on page 1, write on page 2 on the Boox: the tab
  stays on page 1 and page 2 is marked as having unseen ink. Turn to page 2 by hand and the pen
  draws live there. Switch to another tab and back: still where you were, marks intact.
- [ ] **The pen, live.** With the tab on the page being written, the stroke grows under the nib
  with no visible lag and is still there after pen-up.
  - **Watch the moment of pen-up** for a flicker, a doubled line, or a line that disappears and
    comes back. The swap from the live line to the finished stroke is a best guess today (see
    "Later" on #204: the stroke's id in the live BEGIN makes it exact).
  - Pencil: the live line is plain grey and takes its grain at pen-up. Judge whether that change
    of texture is acceptable.
- [ ] **Erase and undo.** Erase a stroke on the Boox: it goes in Sieve. Undo: it returns.
- [ ] **Pages.** Add a page on the Boox and write on it: the page count grows in Sieve.
- [ ] **A whiteboard in its own tab** opens framed around all its ink and uses the editor's width.
  Drag pans, Ctrl+wheel and the − / + buttons zoom, Fit all frames everything, and ink that lands
  outside the window is marked at the nearest edge. Nothing the tablet does moves it.
- [ ] **Open in e-ink.** On a note's tab, with SieveInk in front on the Boox: the Boox opens that
  note, the tab says "Opened on …" and Live appears in the sidebar. With another app in front:
  "SieveInk is not open on the tablet". With Bluetooth off: "No tablet connected". If the note is
  already the live one, check the Boox still answers; if it stays silent the tab will say "The
  tablet did not answer" after five seconds, which would want fixing on the SieveInk side.
- [ ] **Copy page, in the real app.** Copy page, then paste into an image editor: 1404 px wide,
  white, ruled, pencil grain visible, no chrome. Repeat from the Live tab and on a whiteboard after
  panning. This was only seen in headless Chrome; WebKitGTK's image clipboard is unproven.
  - Regression: a smart image's context menu → Copy Image still works.

### Live

- [ ] **Live appears and goes.** Start writing: **Live · {device}** appears in the Ink section
  without a reload, with the note's name. Stop (close the note, or put the Boox to sleep): the Live
  tab says "Waiting for the tablet…" and keeps the last page. Resume within 30 seconds: nothing
  closes. Leave it for more than 30 seconds: the item and the tab go, and the note tabs stay.
- [ ] **The Live tab mirrors the tablet.** It shows the page being written, whole. Turn the page on
  the Boox: it follows. Switch to another note on the Boox: it becomes that note. Wheel, drag and
  keys do nothing in it.
- [ ] **A whiteboard, live.** The Live tab shows the tablet's own window and follows a pan
  smoothly, the ruling staying put on the plane while the ink slides. Open the Live tab after
  panning, or come back to it from another tab: it shows the tablet's window straight away.
- [ ] **Beside the note.** Open the note being written from the Ink list while the Live tab is
  open: two tabs. **Open this note** in the Live tab goes to the note's tab; the note's tab offers
  a way back to Live.
- [ ] **Restart.** Quit with a Live tab open and start again with the tablet idle: no Live tab, the
  other tabs restored.

### Around it

- [ ] **File → Export → Clipboard** on an ink tab or the Live tab does nothing, with no alert; on
  an ordinary note it still copies.
- [ ] **A document and a prompt still behave.** Open, edit and save an ordinary note and a prompt
  beside an ink tab.
