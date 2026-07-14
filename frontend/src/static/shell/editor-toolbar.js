// @ts-check
// editor-toolbar.js — the editor-owned toolbar (P4.D).
//
// The toolbar is EDITOR-owned: NoteEditor constructs an EditorToolbar, which
// mounts into the existing #editor-toolbar host (KEPT in index.html; its inner
// button DOM removed — the ShowToolbar visibility gate + --toolbar-h stay
// Go-driven). It composes, left→right (Stephen 2026-07-12):
//   surface.toolbarContents() + [editor-level groups]
// i.e. formatting FIRST (left), then the editor-level tail (insert, mode-toggle,
// AI-query, help). The editor-level groups (mode-toggle, insert, AI-query, help) PERSIST across
// surface swaps; only the surface section re-renders on a mode flip. Active-state
// (#refresh) fires on the editor's RAW onEvent stream (selection-changed /
// transaction) — NOT the coalesced onSelectionUpdate, which drops caret-only
// moves, so a caret-into-mark move would leave bold/italic active-state stale.
//
// This retires editor.js's syncToolbar + updateModeUI + the legacy-chrome
// selection/transaction/mode-changed fan-out cases. Kind icons come from the
// block-kind registry via getSieveIcon (the icon bus is retired); window.SieveIcons
// (a distinct bus) still backs #icon.
// Dual-use ES module: `export` for vitest; imported by note-editor.js.

import { ToolbarButton, ButtonGroup } from './toolbar-button.js'
import { EditorMode } from './editor-mode.js'
import { getSieveIcon } from '../block/block-kinds.js'

export class EditorToolbar {
  /** @type {import('./abstract-editor.js').AbstractEditor} */
  #editor
  /** @type {HTMLElement|null} the #editor-toolbar host (null → all methods no-op) */
  #host = null
  /** @type {HTMLElement|null} the container span holding the surface's formatting groups */
  #surfaceSection = null
  /** @type {ButtonGroup[]} the persistent editor-level groups (built once) */
  #editorGroups = []
  /** @type {ButtonGroup[]} the current surface's formatting groups (rebuilt on flip) */
  #surfaceGroups = []
  /** @type {ToolbarButton|null} the mode-toggle button (icon/title flips on mode change) */
  #modeButton = null
  /** @type {(() => void)|null} unsubscribe from the editor's raw event stream */
  #unsub = null
  /** @type {import('./editor-mode.js').EditorModeValue|null} the mode the surface section was last built for */
  #renderedMode = null

  /**
   * @param {import('./abstract-editor.js').AbstractEditor} editor
   * @param {HTMLElement|null} [host] — the #editor-toolbar host (defaults to the DOM element)
   */
  constructor(editor, host) {
    this.#editor = editor
    this.#host = host !== undefined ? host : document.getElementById('editor-toolbar')
  }

  /**
   * Mounts the toolbar into its host: builds the persistent editor-level groups
   * once, renders the surface section from the current surface, wires the raw
   * event stream for active-state + the flip re-render, and seeds one refresh.
   */
  mount() {
    if (!this.#host) return
    this.#host.innerHTML = ''
    // Formatting (surface-declared) groups come FIRST (left); the editor-level
    // tail (insert, mode-toggle, AI, help) follows on the right (Stephen 2026-07-12).
    this.#surfaceSection = document.createElement('span')
    this.#surfaceSection.className = 'tb-surface-section'
    this.#host.appendChild(this.#surfaceSection)
    this.#renderSurfaceSection()
    this.#editorGroups = this.#buildEditorGroups()
    for (const g of this.#editorGroups) this.#host.appendChild(g.el)
    // Active-state MUST track the RAW stream (caret-only moves included), and the
    // flip re-render + mode-button refresh ride the same subscription.
    this.#unsub = this.#editor.onEvent((ev) => this.#onEditorEvent(ev))
    this.#syncModeButton()
    this.refresh()
  }

  /** @returns {boolean} whether the toolbar is mounted into a live host */
  get mounted() { return !!(this.#host && this.#surfaceSection) }

  /**
   * Re-renders the surface section against the current surface (a fresh present
   * that did not fire mode-changed — the initial load / same-uuid re-init). The
   * flip case rides #onEditorEvent's mode-changed branch.
   */
  refreshSurfaceSection() {
    if (!this.mounted) return
    // A mode FLIP re-renders via the mode-changed subscription; NoteEditor.present
    // Surface ALSO calls here on that same flip — skip when the mode just changed to
    // avoid a double render. Only a same-mode re-init (softReload / library-switch,
    // which fires NO mode-changed) needs this path. By the time this runs on a flip,
    // super.presentSurface has already swapped #surface, so editor.mode is the NEW
    // mode while #renderedMode is still the OLD one → they differ → skip.
    if (this.#editor.mode !== this.#renderedMode) return
    this.#renderSurfaceSection()
    this.#syncModeButton()
    this.refresh()
  }

  /** Tears down the subscription (editor destroy). */
  destroy() {
    if (this.#unsub) { this.#unsub(); this.#unsub = null }
  }

  /** Refreshes active/enabled state across every group (editor-level + surface). */
  refresh() {
    for (const g of this.#editorGroups) g.refresh()
    for (const g of this.#surfaceGroups) g.refresh()
  }

  /**
   * Shows/hides the (still-static, P4.D-deferred) #table-toolbar when the caret is
   * inside a table, and tracks --table-toolbar-h for the gutter separator — the
   * retired syncToolbar table branch, now driven off the surface's live tiptap.
   */
  #syncTableToolbar() {
    const tableToolbar = document.getElementById('table-toolbar')
    if (!tableToolbar) return
    const ed = /** @type {any} */ (this.#editor.tiptap)
    // FOCUS-GATED: the table utilities bar is an ACTIVE-editing affordance. A doc
    // whose default/restored selection resolves inside a table — e.g. a table as
    // the LAST block, where the doc-end position sits in the trailing table cell —
    // fires selection-changed/transaction on tab-switch load while the editor is
    // UNFOCUSED (tab switch does not applyPosition/focus). Without this gate the
    // bar flashes open even though the caret is not really in the table. hasFocus()
    // separates a real user caret from the programmatic default; the mousedown
    // preventDefault on the table buttons keeps focus during a table command.
    const focused = !!(ed && ed.view && ed.view.hasFocus && ed.view.hasFocus())
    const inTable = focused && !!(ed.isActive && ed.isActive('table'))
    tableToolbar.style.display = inTable ? 'flex' : 'none'
    const appRoot = document.getElementById('app-root')
    if (appRoot) appRoot.style.setProperty('--table-toolbar-h', inTable ? '32px' : '0px')
  }

  /** @param {import('./surfaces/abstract-surface.js').SurfaceEventMsg} ev */
  #onEditorEvent(ev) {
    const t = ev && ev.type
    if (t === 'selection-changed' || t === 'transaction') {
      this.refresh()
      // Table-toolbar visibility is SELECTION-driven — synced ONLY here (matching
      // the pre-P4.D syncToolbar, which ran only on selection-changed/transaction,
      // never at mount). Seeding it in mount()'s refresh flashed the bar open on a
      // fresh tab load whenever the doc's default selection resolved inside a table.
      this.#syncTableToolbar()
    } else if (t === 'mode-changed') {
      // The surface swapped: rebuild ONLY the surface section + refresh the mode
      // button (icon/title). The editor-level groups persist.
      this.#renderSurfaceSection()
      this.#syncModeButton()
      this.refresh()
    }
  }

  /** Rebuilds the surface-formatting groups from the mounted surface's toolbarContents(). */
  #renderSurfaceSection() {
    if (!this.#surfaceSection) return
    this.#surfaceSection.innerHTML = ''
    const surface = this.#editor.surface
    this.#surfaceGroups = surface ? surface.toolbarContents() : []
    this.#surfaceGroups.forEach((g, i) => {
      if (i > 0) {
        const sep = document.createElement('div')
        sep.className = 'tb-sep'
        this.#surfaceSection.appendChild(sep)
      }
      this.#surfaceSection.appendChild(g.el)
    })
    // Trailing divider between the formatting groups and the editor-level tail —
    // only when formatting is present (markdown mode → no dangling separator).
    if (this.#surfaceGroups.length) {
      const sep = document.createElement('div')
      sep.className = 'tb-sep'
      this.#surfaceSection.appendChild(sep)
    }
    // Record the mode this section was built for (the flip-vs-reinit discriminator
    // refreshSurfaceSection reads). Set here so mount / mode-changed / same-mode
    // re-init all keep it current.
    this.#renderedMode = this.#editor.mode
  }

  /** Flips the mode-toggle button's icon + title from the current editor mode (updateModeUI body). */
  #syncModeButton() {
    if (!this.#modeButton) return
    const isMd = this.#editor.mode === EditorMode.MARKDOWN
    this.#modeButton.setIcon(EditorToolbar.#icon(isMd ? 'eye' : 'markdown'))
    this.#modeButton.setTitle(isMd ? 'Return to WYSIWYG' : 'View Markdown Source')
  }

  /**
   * The editor-level groups — persistent across surface swaps (built once). These
   * are the buttons that survive a flip: mode-toggle (the only way back from
   * markdown), insert (code/diagram/web-clip/image), AI-query (explain/ask), help.
   * Each carries its OWN click closure — no delegation, no window.__tiptap hop for
   * the editor verbs (they call the editor / workspace directly).
   * @returns {ButtonGroup[]}
   */
  #buildEditorGroups() {
    const ws = () => /** @type {any} */ (window).sieveWorkspace

    // Mode-toggle: the icon/title is set by #syncModeButton after mount.
    this.#modeButton = new ToolbarButton({
      id: 'tb-toggle-mode-btn',
      title: 'Toggle Editor Mode',
      onClick: () => { const w = ws(); w && w.activeTab && w.activeTab.editor && w.activeTab.editor.toggleMode() },
    })
    const modeGroup = new ButtonGroup([this.#modeButton])

    // Insert: code + diagram (create-block via the editor's create path), web-clip
    // (workspace dialog), image (capture-insert + hidden file input click).
    const insertGroup = new ButtonGroup([
      new ToolbarButton({
        iconHtml: EditorToolbar.#kindIcon('code'), title: 'Insert code block',
        onClick: () => this.#insertBlock('code'),
      }),
      new ToolbarButton({
        iconHtml: EditorToolbar.#kindIcon('diagram'), title: 'Insert diagram',
        onClick: () => this.#insertBlock('diagram'),
      }),
      new ToolbarButton({
        id: 'tb-clip-btn', iconHtml: EditorToolbar.#kindIcon('web-clip'), title: 'Insert web clip',
        onClick: () => { const w = ws(); w && w.openWebClipDialog() },
      }),
      new ToolbarButton({
        id: 'tb-image-btn', iconHtml: EditorToolbar.#kindIcon('smart-image'), title: 'Insert image from file',
        onClick: () => this.#insertImage(),
      }),
    ])

    // AI-query: explain + ask (the workspace AskPanel child). data-icon parity via SieveIcons.
    const aiGroup = new ButtonGroup([
      new ToolbarButton({
        id: 'tb-explain-btn', iconHtml: EditorToolbar.#icon('info'), title: 'Explain',
        onClick: () => { const w = ws(); w && w.askPanel && w.askPanel.explainActive() },
      }),
      new ToolbarButton({
        id: 'tb-ask-btn', iconHtml: EditorToolbar.#icon('sparkle'), title: 'Ask',
        onClick: () => { const w = ws(); w && w.askPanel && w.askPanel.open() },
      }),
    ], { className: 'tb-ai-query' })

    // Help: HTMX /api/help (verbatim from the retired handleToolbarClick).
    const helpGroup = new ButtonGroup([
      new ToolbarButton({
        id: 'tb-help-btn', iconHtml: EditorToolbar.#icon('help'), title: 'Help',
        onClick: () => {
          const htmx = /** @type {any} */ (window).htmx
          if (!htmx) return
          htmx.ajax('GET', '/api/help', { target: '#help-dialog-content', swap: 'innerHTML' })
            .then(() => { const dlg = /** @type {any} */ (document.getElementById('help-dialog')); dlg && dlg.showModal() })
        },
      }),
    ], { className: 'tb-help' })

    // These editor-level groups are the toolbar's TAIL (right): mount() appends
    // them AFTER the surface's formatting groups, so left→right the row reads
    // [formatting] · mode · insert · AI · help. (Formatting active-state is
    // unaffected: it lives in the surface closures, refreshed on the same raw stream.)
    return [modeGroup, insertGroup, aiGroup, helpGroup]
  }

  /** create-block for a toolbar insert (code/diagram) — mirrors the old data-insert path. */
  #insertBlock(kind) {
    if (this.#editor.mode === EditorMode.MARKDOWN) return
    document.dispatchEvent(new CustomEvent('sieve:create-block', { detail: { kind } }))
  }

  /** Toolbar image insert — capture insert-pos (pre-dialog) then click the hidden file input. */
  #insertImage() {
    document.dispatchEvent(new CustomEvent('sieve:capture-insert-pos'))
    const input = document.getElementById('tb-image-input')
    if (input) /** @type {HTMLInputElement} */ (input).click()
  }

  /** @param {string} key @returns {string} the SieveIcons SVG for a key, or '' (icon bus retires P4.E) */
  static #icon(key) {
    const icons = /** @type {any} */ (window).SieveIcons
    return (icons && icons[key]) || ''
  }

  /** @param {string} kind @returns {string} the sieve-kind icon from the block-kind registry */
  static #kindIcon(kind) {
    return getSieveIcon(kind) || ''
  }
}
