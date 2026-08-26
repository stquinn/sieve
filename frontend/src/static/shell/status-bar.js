// @ts-check
// status-bar.js — the status bar as a Workspace child. Constructed ONCE by the
// Workspace and persists across tab/editor switches — it is NOT owned by any
// editor. It owns the three JS-written slots of the static .status-bar DOM:
// __save (+ the #meta-dirty-dot), __blockid, __stats, and REFLECTS the active
// editor by subscribing to its `stats` stream, re-pointing on
// ws.onActiveTabChanged. It is also the sole consumer of two DOM CustomEvents
// whose producers are not migrated: sieve:meta-dirty and editor:blockhover.
//
// The META panel (#htmx-meta-panel) stays HTMX-owned and untouched here.

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
    document.addEventListener('sieve:meta-dirty', (e) => this.#onDirty(/** @type {CustomEvent} */ (e).detail))
    document.addEventListener('editor:blockhover', (e) => this.#onBlockHover(/** @type {CustomEvent} */ (e).detail))
    if (this.#blockIdSlot) this.#blockIdSlot.addEventListener('click', () => this.#copyBlockId())
    this.#ws.onActiveTabChanged((tab) => this.#pointAt(tab))
    this.#pointAt(this.#ws.activeTab)
  }

  /**
   * Re-points the stats subscription at the new active tab's editor, then
   * PULL-seeds the current stats so a subscription that lands after the editor's
   * initial-present emit still paints.
   * @param {import('./tab.js').SieveTab|null} tab
   */
  #pointAt(tab) {
    if (this.#unsubEditor) { this.#unsubEditor(); this.#unsubEditor = null }
    if (!tab) return
    // Subscribe at the TAB level, not the editor: the tab-identity forward
    // survives an editor that attaches AFTER the tab is active. On COLD BOOT
    // openTab makes the tab active before activateDocument attaches the editor,
    // and onActiveTabChanged does not re-fire on the same-tab attach.
    this.#unsubEditor = tab.onStats((ev) => this.#onStats(ev))
    // Also PULL-seed when the editor is ALREADY present (a tab SWITCH after boot:
    // its present seed fired before we subscribed).
    const editor = tab.editor
    if (editor && typeof editor.stats === 'function') this.#onStats(editor.stats())
  }

  /**
   * Paints chars/lines into the __stats slot and sets the --line-digits gutter
   * width.
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
   * Paints the save indicator and the #meta-dirty-dot. detail.dirty true → red
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
   * The TAIL, not the head: a UUIDv7 leads with a millisecond timestamp, so a
   * head-truncated readout is uniform noise across one session. Kind is written
   * explicitly because an opaque id carries none.
   *
   * The last value PERSISTS when the pointer leaves the block: the slot is
   * click-to-copy, and a readout that cleared on mouse-out could never be
   * reached to click.
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
   * enough to read whole (a legacy handle, a transient `tok-…`) come back
   * verbatim.
   * @param {string} id
   * @returns {string}
   */
  #idTail(id) {
    return id.length <= 12 ? id : id.slice(-6)
  }

  /**
   * Copies the FULL id of the last hovered block, flashing the slot to confirm.
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
