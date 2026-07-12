// @ts-check
// status-bar.js — the status bar as a Workspace child (P4.D).
//
// The status bar is constructed ONCE by the Workspace (bootChrome) and persists
// across tab/editor switches — it is NOT owned by any editor. It owns the three
// JS-written slots of the static .status-bar DOM (index.html): __save (+ the
// #meta-dirty-dot), __blockid, __stats. It REFLECTS the active editor by
// subscribing to that editor's onEvent stream (filtered to `stats`) and
// re-pointing on ws.onActiveTabChanged (mirrors AskPanel's re-point on selection).
//
// Two producers stay DOM CustomEvents for now (their producers live inside the
// frozen WS envelope / editor.js's remaining listeners — they retire in P4.E/F):
// sieve:meta-dirty (the flush-ack save paint, abstract-editor #handleMessage) and
// editor:blockhover (editor.js mouseover). Their CONSUMERS moved OUT of index.html
// into this child — the single status-owner is relocated, not split.
//
// The META panel (#htmx-meta-panel) stays HTMX-owned/untouched. Dual-use ES
// module: imported by workspace.js (which constructs it); reached via
// window.sieveWorkspace's #statusBar (no public getter needed — it has no verbs).

export class StatusBar {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {HTMLElement|null} .status-bar__save */
  #saveSlot = null
  /** @type {HTMLElement|null} .status-bar__blockid */
  #blockIdSlot = null
  /** @type {HTMLElement|null} .status-bar__stats */
  #statsSlot = null
  /** @type {(() => void)|null} unsubscribe from the ACTIVE editor's onEvent stream */
  #unsubEditor = null

  /** @param {import('./workspace.js').SieveWorkspace} ws */
  constructor(ws) {
    this.#ws = ws
    this.#saveSlot = document.querySelector('.status-bar__save')
    this.#blockIdSlot = document.querySelector('.status-bar__blockid')
    this.#statsSlot = document.querySelector('.status-bar__stats')
    // The dirty/save paint + block-id readout ride DOM CustomEvents whose producers
    // are NOT yet migrated (frozen WS flush-ack; editor.js mouseover). Consume them
    // here — the consumers moved out of index.html.
    document.addEventListener('sieve:meta-dirty', (e) => this.#onDirty(/** @type {CustomEvent} */ (e).detail))
    document.addEventListener('editor:blockhover', (e) => this.#onBlockHover(/** @type {CustomEvent} */ (e).detail))
    // Reflect the active editor's stats stream; re-point on tab change.
    this.#ws.onActiveTabChanged((tab) => this.#pointAt(tab))
    this.#pointAt(this.#ws.activeTab)
  }

  /**
   * Re-points the stats subscription at the new active tab's editor: drops the old
   * subscription, subscribes to the new editor's onEvent (filtered to `stats`), then
   * PULL-seeds the current stats (editor.stats()) so a subscription that lands after
   * the editor's initial-present emit still paints. Null-guards a tab with no editor
   * yet. Mirrors the workspace's #switchSelectionSource.
   * @param {import('./tab.js').SieveTab|null} tab
   */
  #pointAt(tab) {
    if (this.#unsubEditor) { this.#unsubEditor(); this.#unsubEditor = null }
    if (!tab) return
    // Subscribe at the TAB level (not the editor): the tab-identity forward survives
    // an editor that attaches AFTER the tab is active — on COLD BOOT openTab makes
    // the tab active before activateDocument attaches the editor, and
    // onActiveTabChanged does not re-fire on the same-tab attach. The editor's
    // initial-present stats seed, emitted after attachEditor subscribes, is
    // forwarded through here. (Mirrors the selection stream's tab-level forward.)
    this.#unsubEditor = tab.onStats((ev) => this.#onStats(ev))
    // Also PULL-seed when the editor is ALREADY present (a tab SWITCH after boot: its
    // present seed fired before we subscribed, so there is no pending emit to catch).
    const editor = tab.editor
    if (editor && typeof editor.stats === 'function') this.#onStats(editor.stats())
  }

  /**
   * Paints chars/lines into the __stats slot and sets the --line-digits gutter
   * width (chrome — was editor.js dispatchStats; moved to the consumer).
   * @param {{ chars?: number, lines?: number, blockCount?: number }} ev
   */
  #onStats(ev) {
    if (typeof ev.blockCount === 'number') {
      const digits = Math.max(1, String(ev.blockCount).length)
      document.documentElement.style.setProperty('--line-digits', String(digits))
    }
    if (!this.#statsSlot) return
    this.#statsSlot.innerHTML =
      '<span title="Characters">' + (ev.chars || 0) + ' chars</span>' +
      '<span class="status-bar__sep" title="Lines">' + (ev.lines || 0) + ' lines</span>'
  }

  /**
   * Paints the save indicator + the #meta-dirty-dot from a sieve:meta-dirty detail
   * (verbatim from the retired index.html consumer). detail.dirty true → red
   * "Unsaved"; false → green "Saved".
   * @param {{ dirty?: boolean }|null} detail
   */
  #onDirty(detail) {
    const dirty = !!(detail && detail.dirty)
    const dot = document.getElementById('meta-dirty-dot')
    if (dot) {
      dot.classList.toggle('bg-tn-red', dirty)
      dot.classList.toggle('bg-tn-green', !dirty)
    }
    if (!this.#saveSlot) return
    this.#saveSlot.style.opacity = '1'
    const dotColor = dirty ? 'bg-tn-red' : 'bg-tn-green'
    const label = dirty ? 'Unsaved' : 'Saved'
    this.#saveSlot.innerHTML =
      '<div class="flex items-center gap-[0.4rem]"><span class="w-2 h-2 rounded-full shrink-0 ' + dotColor +
      '"></span><span style="color: var(--theme-textDim);">' + label + '</span></div>'
  }

  /**
   * Writes the hovered block id into the __blockid slot (verbatim from the retired
   * index.html consumer — id only, kind commented out there).
   * @param {{ id?: string, kind?: string }|null} detail
   */
  #onBlockHover(detail) {
    if (!this.#blockIdSlot) return
    this.#blockIdSlot.textContent = detail ? (detail.id || '') : ''
  }
}
