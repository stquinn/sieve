# Focus Count — Activity-Based Increment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate `focus_count` increments on detected user activity so idle-open tabs don't inflate the signal used by the AI filing prompt.

**Architecture:** All changes are client-side. An `__sieveLastActivity` timestamp is updated by DOM input events; the existing `bumpFocus` function checks it before calling `POST /api/note/focus/:id`. Tab switches already reset context (editor re-init fires on `htmx:load`), so setting `__sieveLastActivity = Date.now()` there covers the "switching to a note is itself activity" requirement. The Go server (`handleNoteFocus`, `IncrementFocusCount`) is unchanged.

**Tech Stack:** Vanilla JS in `frontend/src/index.html` — no build step, no dependencies.

---

## File Map

| File | Change |
|------|--------|
| `frontend/src/index.html` | Add `__sieveLastActivity` global; attach activity listeners; add idle guard in `bumpFocus`; reset timestamp on tab init |

---

## Background: Current Focus Timer Flow

In `frontend/src/index.html` (lines 254–287) the focus tracking works as follows:

```
globals initialised (line 254-256):
  __sieveFocusTimer = null
  __sieveDwellInterval = null
  __sieveActiveDocUuid = null

on htmx:load (editor init):
  clear previous timers
  set __sieveActiveDocUuid = uuid
  define bumpFocus():
    if uuid !== active uuid → return
    POST /api/note/focus/:uuid
    refresh meta panel if visible
  setTimeout(bumpFocus, 30s)     ← first bump
  setInterval(bumpFocus, 5min)   ← recurring bumps
```

No activity check exists. A tab open for hours with the user away accumulates focus count every 5 minutes.

---

## Task 1: Add `__sieveLastActivity` global and DOM activity listeners

**Files:**
- Modify: `frontend/src/index.html:254-256` (global init block)

The three existing globals are declared together. We add a fourth and immediately wire up event listeners that update it. Listeners are attached once at startup and live for the app's lifetime — no cleanup needed.

- [ ] **Step 1: Read the current global init block**

  Open `frontend/src/index.html` and confirm lines 254–256 look like:

  ```js
  window.__sieveFocusTimer = null;
  window.__sieveDwellInterval = null;
  window.__sieveActiveDocUuid = null;
  ```

- [ ] **Step 2: Add `__sieveLastActivity` global and activity listeners**

  Replace those three lines with:

  ```js
  window.__sieveFocusTimer = null;
  window.__sieveDwellInterval = null;
  window.__sieveActiveDocUuid = null;
  window.__sieveLastActivity = Date.now();

  (function() {
      var ACTIVITY_EVENTS = ['keydown', 'mousemove', 'scroll', 'click'];
      function recordActivity() { window.__sieveLastActivity = Date.now(); }
      ACTIVITY_EVENTS.forEach(function(ev) {
          document.addEventListener(ev, recordActivity, { passive: true, capture: true });
      });
  })();
  ```

  `capture: true` ensures events inside the TipTap iframe shadow reach the listener.
  `passive: true` is a browser performance hint — required for `scroll` on modern Chrome.
  The IIFE scopes `ACTIVITY_EVENTS` and `recordActivity` so they don't pollute the global namespace.

- [ ] **Step 3: Verify the app still loads**

  Run `wails dev` and open the app. Open the browser console (Ctrl+Shift+I or F12 within the webview). Type:

  ```js
  window.__sieveLastActivity
  ```

  Expected: a recent Unix timestamp (e.g. `1748000000000`). Move the mouse — the value should update when you check again.

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/index.html
  git commit -m "feat(focus-count): track last-activity timestamp via DOM event listeners"
  ```

---

## Task 2: Gate `bumpFocus` on idle threshold + reset on tab switch

**Files:**
- Modify: `frontend/src/index.html:269-287` (focus count tracking logic block)

The idle threshold is 3 minutes (180 000 ms), matching the spec. Switching to a tab is itself activity — we set `__sieveLastActivity = Date.now()` at the top of the `htmx:load` editor-init block, which fires on every tab switch.

- [ ] **Step 1: Read the current `bumpFocus` definition and timer setup**

  Confirm lines 269–287 look like:

  ```js
  // Focus Count tracking logic
  if (window.__sieveFocusTimer) clearTimeout(window.__sieveFocusTimer);
  if (window.__sieveDwellInterval) clearInterval(window.__sieveDwellInterval);
  window.__sieveActiveDocUuid = uuid;

  var bumpFocus = function() {
      if (window.__sieveActiveDocUuid !== uuid) return;
      fetch('/api/note/focus/' + encodeURIComponent(uuid), { method: 'POST' })
          .then(function() {
              var mp = document.getElementById('htmx-meta-panel');
              if (mp && window.getComputedStyle(mp).display !== 'none') {
                  window.htmx.ajax('GET', metaPanelUrl(uuid), { target: '#htmx-meta-panel', swap: 'innerHTML' });
              }
          })
          .catch(console.error);
  };

  window.__sieveFocusTimer = setTimeout(bumpFocus, 30 * 1000);
  window.__sieveDwellInterval = setInterval(bumpFocus, 5 * 60 * 1000);
  ```

- [ ] **Step 2: Add idle guard and tab-switch activity reset**

  Replace that entire block with:

  ```js
  // Focus Count tracking logic
  if (window.__sieveFocusTimer) clearTimeout(window.__sieveFocusTimer);
  if (window.__sieveDwellInterval) clearInterval(window.__sieveDwellInterval);
  window.__sieveActiveDocUuid = uuid;
  window.__sieveLastActivity = Date.now(); // tab switch is itself activity

  var IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

  var bumpFocus = function() {
      if (window.__sieveActiveDocUuid !== uuid) return;
      if (Date.now() - window.__sieveLastActivity > IDLE_THRESHOLD_MS) return;
      fetch('/api/note/focus/' + encodeURIComponent(uuid), { method: 'POST' })
          .then(function() {
              var mp = document.getElementById('htmx-meta-panel');
              if (mp && window.getComputedStyle(mp).display !== 'none') {
                  window.htmx.ajax('GET', metaPanelUrl(uuid), { target: '#htmx-meta-panel', swap: 'innerHTML' });
              }
          })
          .catch(console.error);
  };

  window.__sieveFocusTimer = setTimeout(bumpFocus, 30 * 1000);
  window.__sieveDwellInterval = setInterval(bumpFocus, 5 * 60 * 1000);
  ```

  The only additions are:
  - `window.__sieveLastActivity = Date.now();` — resets idle clock on tab switch
  - `var IDLE_THRESHOLD_MS = 3 * 60 * 1000;` — named constant for readability
  - `if (Date.now() - window.__sieveLastActivity > IDLE_THRESHOLD_MS) return;` — the gate

- [ ] **Step 3: Manually verify — active path**

  In `wails dev`, open a document. In the browser console, set a short test threshold to observe the behaviour without waiting 30 seconds:

  ```js
  // Temporarily patch the threshold for testing:
  // Re-define __sieveLastActivity to 4 minutes ago to simulate idle
  window.__sieveLastActivity = Date.now() - (4 * 60 * 1000);
  ```

  Then switch to another tab and back (to trigger a new `bumpFocus` setup with threshold reset). Open the Meta panel. After 30 seconds the focus count should increment (tab-switch resets to active).

- [ ] **Step 4: Manually verify — idle path**

  In the browser console after opening a document, without touching mouse/keyboard:

  ```js
  // Manually set last activity to 4 min ago (simulating idle)
  window.__sieveLastActivity = Date.now() - (4 * 60 * 1000);
  // Call bumpFocus manually (only works if you assigned it to window for testing)
  ```

  A cleaner approach: watch the Network tab in DevTools. Filter for `focus`. Leave the tab idle (don't touch mouse/keyboard). The 30s initial `setTimeout(bumpFocus)` will fire — confirm in the Network tab that no `POST /api/note/focus/` request appears. Then move the mouse to record activity and wait again — the next interval should send the request.

- [ ] **Step 5: Verify focus_count increments correctly**

  Open the Meta panel for a document. Note the current `focus_count`. Actively use the document (type, scroll) for 35 seconds. Confirm the count increments. Then leave the tab idle for 5+ minutes and confirm it does not increment again.

- [ ] **Step 6: Commit**

  ```bash
  git add frontend/src/index.html
  git commit -m "feat(focus-count): skip increment when user has been idle for >3 minutes"
  ```

---

## Self-Review Against Spec

**Spec requirements vs tasks:**

| Requirement | Covered |
|-------------|---------|
| Track `lastActivity` timestamp | Task 1 — `__sieveLastActivity` global + DOM listeners |
| Updated on cursor movement, keypress, tab switch, scroll | Task 1 — `mousemove`, `keydown`, `scroll`, `click` listeners; Task 2 — explicit reset on tab init |
| Skip increment if idle > threshold (3 min) | Task 2 — `IDLE_THRESHOLD_MS` guard in `bumpFocus` |
| Tab switch resets idle timer | Task 2 — `__sieveLastActivity = Date.now()` at top of editor init |
| Go server unchanged | No Go tasks — confirmed; `handleNoteFocus` and `IncrementFocusCount` untouched |

**Placeholder scan:** None found. All steps contain complete code.

**Type consistency:** `__sieveLastActivity` used consistently as `Date.now()` (number) throughout; `IDLE_THRESHOLD_MS` is local to the `htmx:load` closure and not referenced elsewhere.
