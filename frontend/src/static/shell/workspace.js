// @ts-check
// workspace.js — Workspace singleton (P1: zero-behavior skeleton).
// Workspace is the root of the JS component model. It holds the open Tabs,
// tracks the active Tab, and owns an empty listener registry (listeners wired
// in later phases). It is created once at boot (below) and exposed on window
// as `window.sieveWorkspace` so the browser console can reach it and so
// editor.js (a classic script sharing the same global) can look it up.
// Dual-use ES module (block-position.js pattern): `export` for vitest imports,
// window.* assignment for classic-script access. Loaded in index.html with
// type="module" — a plain <script> tag would fail at parse on `export`.
// Modules execute deferred (after classic scripts parse); editor.js only reads
// window.sieveWorkspace at runtime (initEditor via htmx events), never at parse.

import { SieveTab } from './tab.js'

/**
 * TRANSITIONAL (P2.C; dies P4 when chrome becomes Workspace-owned children):
 * the legacy chrome implementations editor.js registers via provideChrome.
 * @typedef {object} WorkspaceChrome
 * @property {() => void} toggleSearch — show/hide the document search overlay
 * @property {() => void} openWebClipDialog — the Insert WebClip dialog
 * @property {() => void} openUrlCardDialog — the Insert URL Card dialog
 * @property {() => void} copyDocumentAsMarkdown — clean markdown export → clipboard
 */

export class SieveWorkspace {
  /** @type {Map<string, SieveTab>} uuid → Tab */
  #tabs = new Map()

  /** @type {SieveTab|null} */
  #activeTab = null

  // ── Listener registry (empty in P1; typed registration methods wired in P2) ──

  /** @type {Array<(tab: SieveTab|null) => void>} */
  #activeTabListeners = []

  /**
   * Public selection-update registry (P3.B). Mirrors #activeTabListeners: it
   * republishes the ACTIVE tab's selection stream only (a background tab's push
   * never reaches here). Consumers arrive in P3.D (the Ask panel); today it has
   * no production consumer.
   * @type {Array<(ctx: import('./selection-model.js').SelectionContext|null) => void>}
   */
  #selectionListeners = []

  /** @type {(() => void)|null} unsubscribe from the ACTIVE tab's onSelectionUpdate */
  #unsubActiveSelection = null

  constructor() {}

  // ── Tab management ────────────────────────────────────────────────────────────

  /**
   * Returns the Tab for a uuid if it exists, otherwise null.
   * @param {string} uuid
   * @returns {SieveTab|null}
   */
  getTab(uuid) {
    return this.#tabs.get(uuid) ?? null
  }

  /**
   * Opens (creates) a Tab for the given uuid if not already tracked, marks it
   * active, and returns it. Called by editor.js at the start of initEditor.
   * @param {string} uuid
   * @returns {SieveTab}
   */
  openTab(uuid) {
    if (!uuid) throw new Error('SieveWorkspace.openTab: uuid is required')
    let tab = this.#tabs.get(uuid)
    if (!tab) {
      tab = new SieveTab(uuid)
      this.#tabs.set(uuid, tab)
    }
    this.#setActiveTab(tab)
    return tab
  }

  /**
   * Closes (removes) the Tab for a uuid if it is tracked. If it was the active
   * tab, activeTab becomes null. Called by editor.js when the editor tears down.
   * @param {string} uuid
   */
  closeTab(uuid) {
    const tab = this.#tabs.get(uuid)
    if (!tab) return
    this.#tabs.delete(uuid)
    if (this.#activeTab === tab) {
      this.#activeTab = null
      this.#switchSelectionSource(null)
      this.#notifyActiveTabListeners()
    }
  }

  /**
   * Currently active Tab, or null when no document is open.
   * @returns {SieveTab|null}
   */
  get activeTab() { return this.#activeTab }

  // ── Tab-lifecycle verbs (P2.D — the external API facade) ─────────────────────
  // These are the ONLY front-end entry points for tab mutation and the tabbar
  // render. Each is a thin owner over the SAME htmx.ajax call the templates ran
  // before P2.D (identical swap semantics; the OOB editor mount is preserved).
  // The INTERNALS still drive the server-rendered HTMX templates (tabbar.html +
  // OOB editor.html); the self-rendering-JSON version is deferred to tech-debt
  // V-B. Each guards htmx (mirrors the templates' `window.htmx && …`) and returns
  // the htmx.ajax promise. See docs/design/specs/2026-07-08-workspace-editor-
  // component-model.md.

  /**
   * Opens (or focuses) the document for a uuid: POST /api/note/open/{uuid},
   * swapping the tabbar. The server re-renders the strip and OOB-mounts the
   * editor; the OOB re-init drives activateDocument, so no client prune here.
   * @param {string} uuid
   * @returns {Promise<any>}
   */
  open(uuid) {
    return this.#ajax('POST', '/api/note/open/' + encodeURIComponent(uuid))
  }

  /**
   * Creates a new untitled note and opens it: POST /api/note/new, tabbar swap.
   * @returns {Promise<any>}
   */
  newNote() {
    return this.#ajax('POST', '/api/note/new')
  }

  /**
   * Closes the tab for a uuid: POST /api/tabs/close/{uuid}, tabbar swap. Prunes
   * the closed identity AFTER the swap + OOB editor mount + htmx:load settle:
   * by the time `.then` runs, initEditor → activateDocument has already
   * destroyed/detached the outgoing editor and set the new active, so
   * closeTab(uuid) just removes the now-defunct entry (uuid is no longer active,
   * so it won't null #activeTab). Works for both active-tab and background close.
   * @param {string} uuid
   * @returns {Promise<any>}
   */
  close(uuid) {
    return this.#ajax('POST', '/api/tabs/close/' + encodeURIComponent(uuid))
      .then((r) => { this.closeTab(uuid); return r })
  }

  /**
   * Closes the currently active tab, or no-ops when nothing is active. Replaces
   * the native menu's `data-uuid` DOM scrape.
   * @returns {Promise<any>|void}
   */
  closeActiveTab() {
    if (this.#activeTab) return this.close(this.#activeTab.uuid)
  }

  /**
   * Closes every tab: POST /api/tabs/closeAll, tabbar swap. The server wipes the
   * session and creates one fresh note; the OOB re-init activates it before the
   * `.then` prune runs, so pruning every tracked tab EXCEPT the new active
   * collapses the stale entries without touching the fresh note.
   * @returns {Promise<any>}
   */
  closeAll() {
    return this.#ajax('POST', '/api/tabs/closeAll')
      .then((r) => {
        const keep = this.#activeTab
        for (const uuid of [...this.#tabs.keys()]) {
          if (!keep || uuid !== keep.uuid) this.closeTab(uuid)
        }
        return r
      })
  }

  /**
   * Reorders the tab strip: POST /api/tabs/reorder with from/to indices, tabbar
   * swap.
   * @param {number} fromIdx — source tab index
   * @param {number} toPos — target insertion position
   * @returns {Promise<any>}
   */
  reorder(fromIdx, toPos) {
    return this.#ajax('POST', '/api/tabs/reorder', { values: { from: fromIdx, to: toPos } })
  }

  /**
   * Fetches and renders the tab strip: GET /api/tabs, tabbar swap. The boot +
   * SSE refetch entry point (P2.D relocated this off the #htmx-tabbar div's
   * hx-get/hx-trigger).
   * @returns {Promise<any>}
   */
  loadTabs() {
    return this.#ajax('GET', '/api/tabs')
  }

  /**
   * Shared htmx.ajax over the tabbar mount. Guards htmx (mirrors the templates)
   * and always resolves to a promise so `.then` prunes are safe even without
   * htmx present (tests, early boot).
   * @param {'GET'|'POST'} method
   * @param {string} url
   * @param {object} [extraOpts] — merged into the swap options (e.g. values)
   * @returns {Promise<any>}
   */
  #ajax(method, url, extraOpts) {
    if (!window.htmx) return Promise.resolve()
    const opts = Object.assign({ target: '#htmx-tabbar', swap: 'innerHTML' }, extraOpts)
    return window.htmx.ajax(method, url, opts)
  }

  // ── Editor lifecycle (P2.A fix wave: the ONE authoritative teardown path) ────

  /**
   * Activates the document for a uuid, owning the editor lifecycle end-to-end.
   * This is the SINGLE place a previous editor is destroyed:
   *
   * - Genuine tab SWITCH (uuid differs from the active tab's): the previous
   *   editor is destroyed (its WS closes) BEFORE the new tab's editor is
   *   created (its WS opens). That close-before-open ordering is load-bearing
   *   for the Go WS takeover guard (ws_handler.go pointer-identity unregister)
   *   and matches the old openEditorWs behavior (closeEditorWs() first).
   * - TEARDOWN (uuid ''): the active editor is destroyed and its tab closed.
   * - Same-uuid re-activation (toggleMode, a prompt re-init, and any editor.html
   *   re-render for the unchanged active note — e.g. re-opening the active note
   *   from the sidebar, or closing a background tab): the editor instance and
   *   its live socket are KEPT — destroy is never spurious. (Behavior delta vs
   *   the pre-P2.A code, which recycled the socket on those note paths; keeping
   *   it avoids the takeover race entirely.)
   *
   * @param {string} uuid — target document uuid, or '' to tear down
   * @param {object} [options] — passed to the Tab's editor factory
   *   (surfaceCollaborators, onServerMessage, …)
   * @returns {SieveTab|null} the activated Tab, or null after a teardown
   */
  activateDocument(uuid, options) {
    const prev = this.#activeTab
    if (prev && prev.uuid !== uuid) {
      if (prev.editor) {
        prev.editor.destroy()
        prev.detachEditor()
      }
      if (!uuid) this.closeTab(prev.uuid)
    }
    if (!uuid) return null

    const tab = this.openTab(uuid)
    if (!tab.editor) {
      tab.attachEditor(tab.createEditor(uuid, options))
    }
    return tab
  }

  // ── TRANSITIONAL chrome seam (P2.C; DEATH DATE P4 — chrome becomes Workspace-
  // owned child components and this registry dies). The implementations (search
  // overlay, insert dialogs, export fetch) still live in editor.js's IIFE; it
  // registers them once at boot, and the four public methods below ARE the
  // component API the native menu calls (main.go buildMenu). Mirrors the
  // sanctioned P2.B DI pattern: scaffolding with a death date, named as such.

  /** @type {Partial<WorkspaceChrome>} */
  #chrome = {}

  /**
   * Registers legacy chrome implementations (TRANSITIONAL — see banner above).
   * Partial registrations merge.
   * @param {Partial<WorkspaceChrome>} impls
   */
  provideChrome(impls) {
    this.#chrome = Object.assign({}, this.#chrome, impls)
  }

  /** Shows/hides the document search overlay. */
  toggleSearch() { this.#chromeCall('toggleSearch') }

  /** Opens the Insert WebClip dialog. */
  openWebClipDialog() { this.#chromeCall('openWebClipDialog') }

  /** Opens the Insert URL Card dialog. */
  openUrlCardDialog() { this.#chromeCall('openUrlCardDialog') }

  /** Copies the active document's clean markdown export to the clipboard. */
  copyDocumentAsMarkdown() { this.#chromeCall('copyDocumentAsMarkdown') }

  /** @param {keyof WorkspaceChrome} name */
  #chromeCall(name) {
    const fn = this.#chrome[name]
    if (typeof fn !== 'function') {
      console.warn('[workspace] chrome method not registered: ' + name)
      return
    }
    fn()
  }

  // ── Listener registry (P1: registration methods exist, empty — wired P2) ─────

  /**
   * Register a listener called whenever the active tab changes (including to null).
   * Returns an unsubscribe function.
   * @param {(tab: SieveTab|null) => void} fn
   * @returns {() => void}
   */
  onActiveTabChanged(fn) {
    this.#activeTabListeners.push(fn)
    return () => {
      this.#activeTabListeners = this.#activeTabListeners.filter(l => l !== fn)
    }
  }

  /**
   * Register a listener for the ACTIVE tab's selection stream (P3.B). Returns an
   * unsubscribe. The Workspace republishes only the active tab's contexts; a
   * background tab's push is not delivered. On an active-tab change the previous
   * subscription is dropped and the new tab's is taken up, with an immediate
   * D4-synth republish from the new editor's current context (null-guarded); an
   * active→null teardown emits a null context so consumers can clear.
   * @param {(ctx: import('./selection-model.js').SelectionContext|null) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) {
    this.#selectionListeners.push(fn)
    return () => {
      this.#selectionListeners = this.#selectionListeners.filter(l => l !== fn)
    }
  }

  /**
   * Pull the active tab's current frozen SelectionContext, or null when no document
   * is open (P3.E — the read half of the read/write coordinate symmetry). Mirrors
   * the internal pull `#switchSelectionSource` already performs.
   * @returns {import('./selection-model.js').SelectionContext|null}
   */
  getSelectionContext() {
    return this.#activeTab && this.#activeTab.editor
      ? this.#activeTab.editor.getSelectionContext()
      : null
  }

  /**
   * Restore focus/selection on the active tab from a (previously pulled) coordinate
   * (P3.E — the WRITE half; a VERB on the Workspace, never on the frozen context).
   * Routes straight to the active editor's applyPosition (Tab holds no position
   * write). Safe no-op when no document is open or ctx is null.
   * @param {import('./selection-model.js').SelectionContext|null} ctx
   */
  setPosition(ctx) {
    if (ctx && this.#activeTab && this.#activeTab.editor) {
      this.#activeTab.editor.applyPosition(ctx)
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  /** @param {SieveTab|null} tab */
  #setActiveTab(tab) {
    if (this.#activeTab === tab) return
    this.#activeTab = tab
    this.#switchSelectionSource(tab)
    this.#notifyActiveTabListeners()
  }

  /**
   * Re-points the republished selection stream at the new active tab (P3.B):
   * drops the old tab's subscription, subscribes to the new one's
   * onSelectionUpdate, and synthesizes an immediate republish (D4 — a tab change
   * IS a selection change). The synth is null-guarded: when the new tab has no
   * editor yet (openTab→#setActiveTab can precede attachEditor) or its editor's
   * context is null, nothing is synthesized — the tab's own forward delivers the
   * first context once attached. A null active tab (teardown) emits a null
   * context to clear consumers.
   * @param {SieveTab|null} tab
   */
  #switchSelectionSource(tab) {
    if (this.#unsubActiveSelection) { this.#unsubActiveSelection(); this.#unsubActiveSelection = null }
    if (!tab) { this.#notifySelectionListeners(null); return }
    this.#unsubActiveSelection = tab.onSelectionUpdate((ctx) => this.#notifySelectionListeners(ctx))
    const synth = tab.editor ? tab.editor.getSelectionContext() : null
    if (synth) this.#notifySelectionListeners(synth)
  }

  #notifyActiveTabListeners() {
    const tab = this.#activeTab
    for (const fn of this.#activeTabListeners) {
      try { fn(tab) } catch (e) { console.error('[SieveWorkspace] activeTabChanged listener threw', e) }
    }
  }

  /** @param {import('./selection-model.js').SelectionContext|null} ctx */
  #notifySelectionListeners(ctx) {
    for (const fn of this.#selectionListeners) {
      try { fn(ctx) } catch (e) { console.error('[SieveWorkspace] selectionUpdate listener threw', e) }
    }
  }

  // ── Tabbar boot + SSE ownership (P2.D — relocated off the #htmx-tabbar div) ──

  /**
   * Boots the tab strip and subscribes to the out-of-band refresh signals the
   * div's hx-trigger carried before P2.D. The Workspace now OWNS the tabbar
   * render (loadTabs). MECHANISM: htmx's SSE extension fires `sse:*` as bubbling
   * CustomEvents on the divs that declare `hx-trigger="sse:…"` (sidebar/prompts/
   * meta still do), so a document-level listener receives them. The `… from:body`
   * body events (session:changed / notes:changed) likewise bubble to document.
   * Idempotent-safe to call once at module load; guards on #htmx-tabbar existing.
   */
  startTabbar() {
    const boot = () => { if (document.getElementById('htmx-tabbar')) this.loadTabs() }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true })
    } else {
      boot()
    }
    const refresh = () => this.loadTabs()
    document.addEventListener('sse:session:changed', refresh)
    document.addEventListener('sse:notes:changed', refresh)
    document.addEventListener('session:changed', refresh)
    document.addEventListener('notes:changed', refresh)
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
// Created once at module load time. editor.js looks this up via window.sieveWorkspace.
// Acceptance criterion: window.sieveWorkspace.activeTab.editor.uuid works from console.
const workspace = new SieveWorkspace()
window.sieveWorkspace = workspace

// P2.D: the Workspace owns the tab strip render. Boot it + subscribe to the SSE
// refresh signals here (module load — this is the deferred module, so the DOM
// mount exists or DOMContentLoaded is still pending, both handled). Guarded so
// vitest (which imports the class without a real document tab mount) is unaffected.
if (typeof document !== 'undefined') workspace.startTabbar()
