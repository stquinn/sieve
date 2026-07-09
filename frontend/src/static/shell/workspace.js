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

export class SieveWorkspace {
  /** @type {Map<string, SieveTab>} uuid → Tab */
  #tabs = new Map()

  /** @type {SieveTab|null} */
  #activeTab = null

  // ── Listener registry (empty in P1; typed registration methods wired in P2) ──

  /** @type {Array<(tab: SieveTab|null) => void>} */
  #activeTabListeners = []

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
      this.#notifyActiveTabListeners()
    }
  }

  /**
   * Currently active Tab, or null when no document is open.
   * @returns {SieveTab|null}
   */
  get activeTab() { return this.#activeTab }

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
   *   (surfaceFactory, onServerMessage, …)
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

  // ── Private helpers ────────────────────────────────────────────────────────────

  /** @param {SieveTab|null} tab */
  #setActiveTab(tab) {
    if (this.#activeTab === tab) return
    this.#activeTab = tab
    this.#notifyActiveTabListeners()
  }

  #notifyActiveTabListeners() {
    const tab = this.#activeTab
    for (const fn of this.#activeTabListeners) {
      try { fn(tab) } catch (e) { console.error('[SieveWorkspace] activeTabChanged listener threw', e) }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
// Created once at module load time. editor.js looks this up via window.sieveWorkspace.
// Acceptance criterion: window.sieveWorkspace.activeTab.editor.uuid works from console.
const workspace = new SieveWorkspace()
window.sieveWorkspace = workspace
