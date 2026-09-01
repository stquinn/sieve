// @ts-check
// The editor-owned toolbar. It composes left→right as
//   surface.toolbarContents() + [editor-level groups]
// so formatting comes first and the editor-level tail (insert, mode-toggle,
// AI-query, help) follows. The editor-level groups PERSIST across surface swaps;
// only the surface section re-renders on a mode flip.
//
// Active-state (#refresh) fires on the editor's RAW onEvent stream
// (selection-changed / transaction) and NOT the coalesced onSelectionUpdate, which
// drops caret-only moves and would leave bold/italic active-state stale.

import { ToolbarButton, ButtonGroup } from './toolbar-button.js'
import { EditorMode } from './editor-mode.js'
import { getSieveIcon } from '../../renderers/block-kinds.js'

export class EditorToolbar {
  /** @type {import('../abstract-editor.js').AbstractEditor} */
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
   * @param {import('../abstract-editor.js').AbstractEditor} editor
   * @param {HTMLElement|null} [host] — the #editor-toolbar host (defaults to the DOM element)
   */
  constructor(editor, host) {
    this.#editor = editor
    this.#host = host !== undefined ? host : document.getElementById('editor-toolbar')
  }

  mount() {
    if (!this.#host) return
    this.#host.innerHTML = ''
    this.#surfaceSection = document.createElement('span')
    this.#surfaceSection.className = 'tb-surface-section'
    this.#host.appendChild(this.#surfaceSection)
    this.#renderSurfaceSection()
    this.#editorGroups = this.#buildEditorGroups()
    for (const g of this.#editorGroups) this.#host.appendChild(g.el)
    this.#unsub = this.#editor.onEvent((ev) => this.#onEditorEvent(ev))
    this.#syncModeButton()
    this.refresh()
  }

  /** @returns {boolean} whether the toolbar is mounted into a live host */
  get mounted() { return !!(this.#host && this.#surfaceSection) }

  /**
   * Re-renders the surface section against the current surface — the initial load
   * or a same-uuid re-init. The flip case rides #onEditorEvent's mode-changed branch.
   */
  refreshSurfaceSection() {
    if (!this.mounted) return
    // A mode FLIP re-renders via the mode-changed subscription, and presentSurface
    // also lands here on that same flip — by then editor.mode is the NEW mode while
    // #renderedMode is still the old, so they differ and the double render is
    // skipped. Only a same-mode re-init (reload / library switch) needs this path.
    if (this.#editor.mode !== this.#renderedMode) return
    this.#renderSurfaceSection()
    this.#syncModeButton()
    this.refresh()
  }

  destroy() {
    if (this.#unsub) { this.#unsub(); this.#unsub = null }
  }

  refresh() {
    for (const g of this.#editorGroups) g.refresh()
    for (const g of this.#surfaceGroups) g.refresh()
  }

  /**
   * Shows/hides the static #table-toolbar when the caret is inside a table, and
   * tracks --table-toolbar-h for the gutter separator.
   */
  #syncTableToolbar() {
    const tableToolbar = document.getElementById('table-toolbar')
    if (!tableToolbar) return
    const ed = /** @type {any} */ (this.#editor.editorPane)
    // FOCUS-GATED: the table bar is an ACTIVE-editing affordance. A doc whose
    // restored selection resolves inside a table — a table as the LAST block, say —
    // fires selection-changed on tab-switch load while the editor is UNFOCUSED, and
    // without this gate the bar flashes open. hasFocus() separates a real user caret
    // from the programmatic default.
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
      // Table-toolbar visibility is SELECTION-driven and synced ONLY here, never at
      // mount: seeding it there flashes the bar open on a fresh tab load.
      this.#syncTableToolbar()
    } else if (t === 'mode-changed') {
      this.#renderSurfaceSection()
      this.#syncModeButton()
      this.refresh()
    }
  }

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
    // Trailing divider only when formatting is present (markdown mode → no dangling
    // separator).
    if (this.#surfaceGroups.length) {
      const sep = document.createElement('div')
      sep.className = 'tb-sep'
      this.#surfaceSection.appendChild(sep)
    }
    // The flip-vs-reinit discriminator refreshSurfaceSection reads.
    this.#renderedMode = this.#editor.mode
  }

  #syncModeButton() {
    if (!this.#modeButton) return
    const isMd = this.#editor.mode === EditorMode.MARKDOWN
    this.#modeButton.setIcon(EditorToolbar.#icon(isMd ? 'eye' : 'markdown'))
    this.#modeButton.setTitle(isMd ? 'Return to WYSIWYG' : 'View Markdown Source')
  }

  /**
   * The editor-level groups, built once and persistent across surface swaps: the
   * mode-toggle (the only way back from markdown), insert, AI-query and help. Each
   * carries its OWN click closure — no delegation.
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
    // Spelling is a WORKSPACE-wide setting, not this document's: the button
    // reads and writes the one the host holds, and repaints itself the moment
    // it is pressed rather than waiting for the editor's next event.
    const spellButton = new ToolbarButton({
      id: 'tb-spellcheck-btn', iconHtml: EditorToolbar.#icon('spellcheck'), title: 'Spell check',
      active: () => { const w = ws(); return !!(w && w.spell && w.spell.enabled) },
      onClick: () => { const w = ws(); w && w.spell && w.spell.toggle(); spellButton.refresh() },
    })
    const modeGroup = new ButtonGroup([this.#modeButton, spellButton])

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
        id: 'tb-attach-btn', iconHtml: EditorToolbar.#icon('paperclip'), title: 'Attach a file',
        onClick: () => this.#attachFile(),
      }),
    ])

    const aiGroup = new ButtonGroup([
      new ToolbarButton({
        id: 'tb-explain-btn', iconHtml: EditorToolbar.#icon('explain'), title: 'Explain',
        onClick: () => { const w = ws(); w && w.askPanel && w.askPanel.explainActive() },
      }),
      new ToolbarButton({
        id: 'tb-ask-btn', iconHtml: EditorToolbar.#icon('ask'), title: 'Ask',
        onClick: () => { const w = ws(); w && w.askPanel && w.askPanel.open() },
      }),
    ], { className: 'tb-ai-query' })

    const helpGroup = new ButtonGroup([
      new ToolbarButton({
        id: 'tb-help-btn', iconHtml: EditorToolbar.#icon('help'), title: 'Help',
        onClick: () => {
          const htmx = /** @type {any} */ (window).htmx
          if (!htmx) return
          htmx.ajax('GET', '/ui/views/help', { target: '#help-dialog-content', swap: 'innerHTML' })
            .then(() => { const dlg = /** @type {any} */ (document.getElementById('help-dialog')); dlg && dlg.showModal() })
        },
      }),
    ], { className: 'tb-help' })

    return [modeGroup, insertGroup, aiGroup, helpGroup]
  }

  /** create-block for a toolbar insert (code/diagram) — the editor derives the caret index. */
  #insertBlock(kind) {
    if (this.#editor.mode === EditorMode.MARKDOWN) return
    this.#editor.createBlock(kind, {})
  }

  /**
   * Attach a file. ONE affordance for every file type: the button never names a
   * block kind — it hands bytes and a mime type to smart-paste and the paste-match
   * registry decides, so adding a kind extends this button without touching it.
   *
   * The insert ANCHOR is captured BEFORE the dialog opens, because opening it blurs
   * the editor and the caret would re-derive to the end of the document. It is
   * stashed on the window because the picker's change handler lives in the app
   * shell's inline script, which is not a module.
   */
  #attachFile() {
    /** @type {any} */ (window).__sieveCapturedInsertAnchor = this.#editor.captureImageInsert()
    const input = document.getElementById('tb-attach-input')
    if (input) /** @type {HTMLInputElement} */ (input).click()
  }

  /** @param {string} key @returns {string} the SieveIcons SVG for a key, or '' */
  static #icon(key) {
    const icons = /** @type {any} */ (window).SieveIcons
    return (icons && icons[key]) || ''
  }

  /** @param {string} kind @returns {string} the sieve-kind icon from the block-kind registry */
  static #kindIcon(kind) {
    return getSieveIcon(kind) || ''
  }
}
