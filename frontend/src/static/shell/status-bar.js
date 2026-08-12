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
  /** @type {string} full id of the last hovered block — what click-to-copy yields */
  #hoveredBlockId = ''

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
    if (this.#blockIdSlot) this.#blockIdSlot.addEventListener('click', () => this.#copyBlockId())
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
   * Writes the hovered block's kind and id-tail into the __blockid slot.
   *
   * Block ids became UUIDs in #75, which broke the old verbatim readout twice
   * over. The slot ellipsises, so a 36-char id truncated to its HEAD — and a
   * UUIDv7 leads with a millisecond timestamp, so every block minted in one
   * session shares that prefix and the readout became uniform noise. The
   * discriminating half is the tail, so that is what is shown. Kind is shown
   * explicitly too: it used to ride along free in the `pr-`/`co-` prefix, and
   * opaque ids carry no kind at all.
   *
   * The last value PERSISTS when the pointer leaves the block (the old consumer
   * blanked it). It has to: the slot is click-to-copy, and a readout that
   * cleared on mouse-out could never be reached to click.
   * @param {{ id?: string, kind?: string }|null} detail
   */
  #onBlockHover(detail) {
    if (!this.#blockIdSlot) return
    const id = (detail && detail.id) || ''
    if (!id) return // keep the last readout — see above
    this.#hoveredBlockId = id
    const kind = (detail && detail.kind) || ''
    this.#blockIdSlot.textContent = (kind ? kind + '·' : '') + this.#idTail(id) + ' ⧉'
    this.#blockIdSlot.title = id + ' (click to copy)'
    this.#blockIdSlot.style.cursor = 'pointer'
  }

  /**
   * The distinguishing tail of a block id: the last 6 chars of a UUID. Ids short
   * enough to read whole (a legacy handle in a document not yet migrated, a
   * transient `tok-…`) are returned verbatim — truncating those would lose
   * information rather than noise.
   * @param {string} id
   * @returns {string}
   */
  #idTail(id) {
    return id.length <= 12 ? id : id.slice(-6)
  }

  /**
   * Copies the FULL id of the last hovered block, flashing the slot to confirm.
   * The full id is what is useful off-screen (a bug report, a ref, and in time a
   * block: coordinate) — the tail is only ever a legible stand-in.
   */
  async #copyBlockId() {
    const slot = this.#blockIdSlot
    if (!slot || !this.#hoveredBlockId) return
    try {
      await navigator.clipboard.writeText(this.#hoveredBlockId)
    } catch (err) {
      return // clipboard denied — say nothing rather than flash a false success
    }
    const restore = slot.textContent
    slot.textContent = 'copied'
    window.setTimeout(() => {
      // Only restore if nothing else repainted the slot in the meantime.
      if (slot.textContent === 'copied') slot.textContent = restore
    }, 900)
  }
}
