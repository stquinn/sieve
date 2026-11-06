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
- [ ] **Wrong key.** Settings → Notebooks → New key, without re-pairing: Link reads "key rejected —
  re-enter the key on the Boox", the redial slows down instead of repeating every second, nothing
  on disk changes. Re-pair with the new key and it connects.
- [ ] **Throughput.** Catch-up ran at 27 kB/s against the spike's 63–75 kB/s. With a library of a
  few hundred kB, note Settings → Notebooks → Last Session → Throughput on a fresh sync. Fine for a pen;
  wanted before the Mac's number is compared with it.
- [ ] **The corporate Mac.** Install the `macos` artifact of the GitHub `Release (macOS)` run for
  the newest `mac-test-*` tag (`mac-test-4` or later; never `mac-test-2`, whose frontend is broken) (Actions tab; such a tag publishes no release). The tablet must be on
  the SDU-cap SieveInk build first.
  - Settings → Notebooks → tick the toggle. macOS should ask whether Sieve may use Bluetooth; allow it.
    No prompt and Link reading "…not authorised to use Bluetooth…" means device management has
    refused it: stop and send the log. "Bluetooth is off": turn it on, it recovers by itself.
  - Pair, sync, write live, and drop and resume, as on Linux. Write down Time to connect and
    Throughput beside Linux's.
  - If anything fails, send the Link line as shown and the log from the first
    `ink bluetooth manager created` line. Each failure names its step: `gatt connect`,
    `discover service`, `read psm`, `open l2cap channel psm=…`, `open l2cap streams`,
    `l2cap read: nothing received for 10s`.

## Phase 4 — the lens and Live (#211)

With Ink enabled, the library tree starts with a **Notebooks** item; expanded, it holds **Live** while
the tablet is writing, then the synced notes. Live is SieveInk's own view, whichever note that is; a note's own
tab is the reader's.

### A note's own tab

- [ ] **A synced page looks like the page.** Open a note with pen and pencil on a ruled page from
  the Notebooks item. The sheet is white whatever the theme, the ruling sits under the ink, pen
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
- [x] **A whiteboard in its own tab** (confirmed by hand 2026-11-06, no issues found) opens framed around all its ink and uses the editor's width.
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

- [ ] **Live appears and goes.** Start writing: **Live · {device}** appears in the Notebooks item
  without a reload, with the note's name. Stop (close the note, or put the Boox to sleep): the Live
  tab says "Waiting for the tablet…" and keeps the last page. Resume within 30 seconds: nothing
  closes. Leave it for more than 30 seconds: the item and the tab go, and the note tabs stay.
- [ ] **The Live tab mirrors the tablet.** It shows the page being written, whole. Turn the page on
  the Boox: it follows. Switch to another note on the Boox: it becomes that note. Wheel, drag and
  keys do nothing in it.
- [x] **A whiteboard, live.** (confirmed by hand 2026-11-06) The Live tab shows the tablet's own window and follows a pan
  smoothly, the ruling staying put on the plane while the ink slides. Open the Live tab after
  panning, or come back to it from another tab: it shows the tablet's window straight away.
- [ ] **Beside the note.** Open the note being written from the Notebooks list while the Live tab is
  open: two tabs. **Open this note** in the Live tab goes to the note's tab; the note's tab offers
  a way back to Live.
- [ ] **Restart.** Quit with a Live tab open and start again with the tablet idle: no Live tab, the
  other tabs restored.

### Around it

- [ ] **File → Export → Clipboard** on an ink tab or the Live tab does nothing, with no alert; on
  an ordinary note it still copies.
- [ ] **A document and a prompt still behave.** Open, edit and save an ordinary note and a prompt
  beside an ink tab.

## Phase 5 — names and the reading (#212)

Needs an AI CLI configured (Settings → AI). Everything here was only ever run against a scripted
model: no real model has seen a page.

### A note names itself

A note is named once it has gone quiet: no stroke for five minutes, whether or not the tablet still shows it. To
shorten the wait while testing, add `"settle_seconds": 30` inside `"ink"` in
`{store}/{hostname}/config/settings.json` and restart.

- [ ] **A sensible name.** Write a note about something specific, close it on the Boox and wait.
  One "Naming …" job appears in the status bar; afterwards the sidebar's Notebooks item, the note's
  tab and Settings → Notebooks show a short, specific title instead of the tablet's "Untitled …".
  Judge the title, and the summary and keywords in the note's `.meta`.
- [ ] **The model really sees the pages.** The name reflects what was written, not a guess. If it
  is generic, the model is not opening the page images: send the log around `name-note`.
  This matters most for a CLI other than claude, whose access to the note's directory is untested.
- [ ] **On the Boox.** The name, keywords and summary arrive in SieveInk for that note. Check how
  they look there, a keyword containing a comma included.
- [ ] **Named again after more writing.** Write more on a named note and stop: about five minutes
  after the last stroke it is named again, once, and the Boox gets the newer name.
- [ ] **Named while the tablet is away.** Let a note settle with the Boox's Bluetooth off; the name
  appears in Sieve. Turn Bluetooth on: the Boox gets it on connect.
- [ ] **Nothing is named twice.** Restart Sieve with nothing new written: no "Naming …" job.
- [ ] **A long note.** With eight or more dense pages, the job finishes inside the CLI timeout
  (60 s). If it times out, set `"prompt_timeouts": {"note-meta": 180}` and say so.
- [ ] **Page drawing in the real window.** Naming draws the pages in Sieve's own window, with no
  tab open on the note. Under test this took 16–20 s a page in WebKitGTK with software rendering
  and 1.4 s in Chrome; with real GPU rendering it should be near the latter. If names never
  arrive and the log says a page was not drawn, that is this.
- [ ] **No AI configured.** With the CLI unset, no job runs and notes keep the tablet's title.

### Reading a page

In a note's own tab, **Page | Reading** in the bar, or Mod+Enter, switches between the ink and its
reading. A reading belongs to one page and is made only when asked for.

- [ ] **Handwriting as text.** On a page of real handwriting: Reading → Read this page. The text is
  faithful, headings and lists are kept, and a word the model could not read shows as `[?]`.
- [ ] **A sketch as a diagram.** A page with a hand-drawn flow or boxes-and-arrows comes back with
  a Mermaid diagram that draws. With a PlantUML server configured, a sequence sketch may come back
  as PlantUML and should draw too; without one it shows its source under a short error.
- [ ] **Read once.** Leave the page and come back, or restart Sieve: the reading is there with no
  new job. There is no way to redo a reading of an unchanged page; say if that is wanted.
- [ ] **Stale.** Write on that page on the Boox: the reading dims with "This page has changed since
  it was read" and no reload. Read again replaces it, and the note's directory holds one
  `reading-…json` for the page, not two.
- [ ] **New document.** New document opens an ordinary note named "{name} — page n" holding the
  text and diagrams. Edit it, file it, close it: it behaves like any note, and the ink note and its
  reading are unchanged.
- [ ] **The name in the bar.** A note open in a tab when it is named: the bar changes to the new
  name without a reload.
- [ ] **In the real window.** Mod+Enter switches modes and the keyboard follows (PageUp/PageDown
  still turn pages in Reading). Only exercised in Chrome so far.
- [ ] **No AI configured.** Reading says why and offers no button.

## After the first hands-on session (2026-11-06)

Confirmed by hand in the real window that day: the workspace toolbar on a notebook tab, Fit page,
the pencil drawing with its grain while the pen is down, and whiteboards.

Built since, never seen in the real window, and some of it never run in a browser at all:

- [ ] **The toolbar's layout.** On a notebook tab: pager on the left, scale in the middle, actions
  and the Page | Reading toggle on the right, on one row at your usual window width, with a status
  message, "n unseen" and "Live ↗" showing. An ordinary note's toolbar looks exactly as it did.
- [ ] **Scale drop-down.** 25 to 200 %, Fit width, Fit page. The list opens and closes, and
  PageUp/PageDown work straight after choosing with the mouse. Ctrl+wheel and a trackpad pinch
  step through the percentages.
- [ ] **Page drop-down.** Lists the pages, shows "9 / 14" closed, marks pages with ink you have not
  seen, and "n unseen" jumps to the next one.
- [ ] **Right-click on the page, the reading and the Live view** shows the notebook's actions; the
  menu key (or Shift+F10) raises it too. Read this page and Refresh name and summary are here and
  not in the toolbar.
- [ ] **Fit all keeps fitting.** A whiteboard opens framing all its ink and keeps re-framing as you
  draw beyond it, the Fit all button shown pressed. Pan or zoom and it stops; ink outside then
  shows the edge marker; Fit all starts it again.
- [ ] **Open in e-ink goes to the page you are on** (needs SieveInk's `open-note-page` build on the
  tablet; against the older build the link drops and reconnects). Also with the notebook already
  open on another page, and already on that page.
- [ ] **Notebooks in the tree.** First item of the library tree, collapsed by default, remembered
  across a restart; a red dot on it while the tablet is writing and it is collapsed; folders stay
  expanded and the scroll holds while ink arrives. Watch for a notebook opening by itself when
  Notebooks is first expanded: seen once in testing, never reproduced.
- [ ] **Naming you can predict.** Leave a notebook open on the tablet and stop writing: it is named
  five minutes later, open or not. Restart Sieve with a quiet unnamed notebook: named within about
  half a minute. The log says `ink: named a note`, or why it was not.
- [ ] **Refresh name and summary** from a notebook's tree row, its tab, the page's menu and the
  Meta panel names it again at once. With no AI configured it says so in the status bar, in red.
- [ ] **The Meta panel on a notebook** shows name, summary, keywords, categories, device, pages and
  what the description is of. An ordinary note's panel is unchanged.
- [ ] **Tabs stay in sight.** In a window narrow enough that tabs overflow: opening anything puts
  its tab in the right-most visible slot and the tab that leaves is the one you used longest ago;
  clicking a visible tab moves nothing; two overflow tabs flicked between both stay visible; a
  dragged tab stays where it is dropped. **Not proven:** dragging the active tab to the far end,
  past the fold — in testing it was moved back once.
