// @ts-check
// ask-panel.js — the Ask panel as a PERMANENT Workspace child (P4.B).
//
// The Ask panel is constructed ONCE by the Workspace (bootChrome) and persists
// across tab/editor switches — it is NOT owned by any editor. It REFLECTS the
// active editor by subscribing to workspace.onSelectionUpdate (the P3.B stream:
// republishes the active tab + synthesizes on tab-switch), so the label tracks
// the caret / focus / tab change. On SEND it targets ws.activeTab.editor and
// calls the ONE editor seam (editor.askAi) — the child owns the DIALOG, the
// editor owns the doc mutation.
//
// It wires the STRUCTURAL #ask-panel DOM from index.html (never rebuilds it) and
// null-guards a missing panel (headless boot / vitest import). TipTap is reached
// ONLY through editor methods (getSelectionContext / askAi / prepareAiTarget) and
// the transitional window.TipTap.applyTargetHighlight helper (bus retirement is
// P4.E). The Ask-panel FOCUS GLOW was DROPPED in P4.B — the panel paints nothing.
//
// Dual-use ES module: imported by workspace.js (which constructs it). No window.*
// export — the singleton is reached via window.sieveWorkspace.askPanel.

export class AskPanel {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {HTMLElement|null} the structural #ask-panel (null → all methods no-op) */
  #panel = null
  /** @type {HTMLTextAreaElement|null} */
  #textarea = null
  /** @type {HTMLElement|null} */
  #label = null
  /** @type {boolean} pin state — one persisted boolean (ShowAskPanel), mirrored here */
  #pinned = false
  /** @type {ReturnType<typeof setTimeout>|null} label debounce */
  #labelTimeout = null
  /** @type {import('./selection-model.js').SelectionContext|null} focus coordinate pulled on jump-in */
  #focusReturn = null

  /** @param {import('./workspace.js').SieveWorkspace} ws */
  constructor(ws) {
    this.#ws = ws
    this.#panel = document.getElementById('ask-panel')
    this.#pinned = !!window.initAskPanelPinned
    if (!this.#panel) return
    this.#textarea = this.#panel.querySelector('.ask-popup__input')
    this.#label = this.#panel.querySelector('.ask-popup__label')
    this.#wireDom()
    this.#wirePinToggle()
    this.#wireGlobalHotkey()
    this.#wireAiEvents()
    // The panel tracks the canonical selection stream (P3.D closure, now OWNED
    // here). The workspace republishes only the active tab + synthesizes on
    // tab-switch, so the label refreshes on caret move, focus change, AND tab
    // change. NO glow — dropped in P4.B.
    this.#ws.onSelectionUpdate((ctx) => this.#onSelectionUpdate(ctx))
  }

  // ── Public verbs the entry points call ────────────────────────────────────────

  /**
   * Opens the Ask box: toggle-out if it already has focus (focus axis only —
   * pin/visibility is independent), else pull the focus coordinate for jump-out,
   * show, seed the label, and focus the textarea.
   */
  open() {
    if (!this.#panel || !this.#textarea) return
    if (this.#panel.classList.contains('is-open') && document.activeElement === this.#textarea) {
      this.close()
      return
    }
    // Jump IN: pull where focus was so jump-out restores it exactly. Must run
    // before the textarea steals focus below — the coordinate is still live here.
    this.#focusReturn = this.#ws.getSelectionContext()
    this.#panel.classList.add('is-open')
    this.#refreshLabel()
    const ta = this.#textarea
    setTimeout(() => ta.focus(), 50)
  }

  /**
   * Jumps back to the editor (the former returnToEditor): hides the panel if
   * unpinned, restoring the caret to where we were on jump-in. Focus and panel
   * visibility are independent — a jump-out NEVER touches the persisted pin state.
   * This is what a Ctrl+Shift+A jump-out and the open() toggle-out call.
   */
  close() {
    if (!this.#panel) return
    if (!this.#pinned) this.#panel.classList.remove('is-open')
    this.#ws.setPosition(this.#focusReturn)
  }

  /**
   * Dismisses the panel (the former closePanel — the ✕ button / Escape): "View
   * Ask panel on/off" and "pin" are ONE persisted boolean, so when pinned ON, ✕
   * untoggles it through the same endpoint the View menu uses (persisting off);
   * a transient ambient open just hands focus back and hides (close()).
   */
  #dismiss() {
    if (this.#pinned && window.htmx) {
      window.htmx.ajax('POST', '/api/session/askpanel/toggle', { swap: 'none' })
    }
    this.close()
  }

  /**
   * Focus-agnostic toggle (the non-PM Ctrl+Shift+A body): if the box has focus,
   * jump back out; otherwise jump in.
   */
  toggle() {
    if (this.#panel && this.#panel.classList.contains('is-open') && document.activeElement === this.#textarea) {
      this.close()
    } else {
      this.open()
    }
  }

  /**
   * Resolve the active editor + prepare its target, then run an explain job. The
   * ONE explain entry the transitional sieve:ai-explain (and the toolbar) reach.
   */
  explainActive() {
    const ed = this.#activeEditor()
    if (ed && ed.prepareAiTarget()) ed.askAi({ type: 'explain' })
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /** @returns {any} the live active editor, or null */
  #activeEditor() {
    return (this.#ws.activeTab && this.#ws.activeTab.editor) || null
  }

  /** Binds send / close / Enter / Escape onto the structural #ask-panel. */
  #wireDom() {
    const panel = /** @type {HTMLElement} */ (this.#panel)
    const textarea = /** @type {HTMLTextAreaElement} */ (this.#textarea)
    const sendBtn = panel.querySelector('.ask-popup__send')
    const closeBtn = panel.querySelector('.ask-popup__close')

    if (sendBtn) sendBtn.addEventListener('click', () => this.#send())
    if (closeBtn) closeBtn.addEventListener('click', () => this.#dismiss())

    textarea.addEventListener('keydown', (e) => {
      // Ctrl+Shift+A (jump back out) is the global hotkey — only Enter/Escape are box-local.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.#send() }
      if (e.key === 'Escape') { e.preventDefault(); this.#dismiss() }
    })
  }

  /** Reflects the persisted View-menu toggle onto the panel's open state. */
  #wirePinToggle() {
    document.addEventListener('sieve:ask-panel-toggled', (e) => {
      this.#pinned = /** @type {CustomEvent} */ (e).detail
      if (!this.#panel) return
      if (this.#pinned) this.#panel.classList.add('is-open')
      else if (document.activeElement !== this.#textarea) this.#panel.classList.remove('is-open')
    })
  }

  /**
   * The non-PM Ctrl/Mod+Shift+A entry: the PM keymap owns the main-editor-focused
   * case (bail then), and the shortcut is not hijacked inside the sidebar or a
   * modal dialog.
   */
  #wireGlobalHotkey() {
    document.addEventListener('keydown', (e) => {
      if ((e.key !== 'a' && e.key !== 'A') || !window.isMod(e) || !e.shiftKey || e.altKey) return
      const ed = this.#activeEditor()
      const tiptap = ed && ed.tiptap
      // No target at all (no editor and not markdown) → nothing to ask about.
      if (!tiptap && (!ed || ed.mode !== 'markdown')) return
      // The PM keymap owns the main-editor-focused case — let it handle that.
      if (tiptap && tiptap.view && tiptap.view.hasFocus && tiptap.view.hasFocus()) return
      const ae = document.activeElement
      if (ae && ae.closest && ae.closest('#htmx-sidebar, dialog')) return
      e.preventDefault()
      this.toggle()
    })
  }

  /**
   * TRANSITIONAL (P4.B; death date P4.D/F): the sieve:ai-ask / sieve:ai-explain
   * events still ride from the producers that lack a clean handle to reach this
   * child directly — the surface PM keymap, the context-menu items, the
   * sieve-block affordance. Their consumers now live HERE (moved out of editor.js)
   * so the single business seam is relocated, not split. The toolbar and the
   * Ctrl+Shift+A hotkey are de-evented (they call open()/toggle()/explainActive
   * directly).
   */
  #wireAiEvents() {
    document.addEventListener('sieve:ai-ask', () => this.open())
    document.addEventListener('sieve:ai-explain', () => this.explainActive())
  }

  /**
   * SEND: pull the LIVE target the editor STORED (F1 — no captured copy), apply
   * the == highlight ONLY for a live selection in wysiwyg (the one mutating case),
   * run the ONE editor seam, then hand focus back to the editor (SEND is a
   * doc-mutating action — focus follows the action, collapsing to the answer's end).
   */
  #send() {
    if (!this.#textarea) return
    const val = this.#textarea.value.trim()
    if (!val) return
    const ed = this.#activeEditor()
    if (!ed) return
    const context = ed.getSelectionContext()
    if (context && context.target && context.target.kind === 'selection' && ed.mode !== 'markdown') {
      window.TipTap.applyTargetHighlight(ed.tiptap)
    }
    ed.askAi({ type: 'ask', question: val })
    this.#textarea.value = ''
    if (this.#panel && !this.#pinned) this.#panel.classList.remove('is-open')
    // Focus FOLLOWS the action: hand focus to the editor and collapse the caret to
    // the END of the target (right where the answer lands). Jump-out (navigation)
    // still restores the exact context via close().
    const tiptap = ed.tiptap
    if (tiptap && tiptap.view) {
      tiptap.view.focus()
      try { tiptap.commands.setTextSelection(tiptap.state.selection.to) } catch (e) { /* best-effort */ }
    }
    this.#focusReturn = null
  }

  /**
   * The P3.D boot closure, now OWNED here: on a meaningful selection change,
   * re-render the label when the panel is open. NO glow (dropped in P4.B).
   * @param {import('./selection-model.js').SelectionContext|null} ctx
   */
  #onSelectionUpdate(ctx) {
    if (!ctx) return
    if (this.#panel && this.#panel.classList.contains('is-open')) this.#refreshLabel()
  }

  /** Debounced label re-render from the live target label (pull at refresh, F2). */
  #refreshLabel() {
    if (!this.#panel || !this.#label) return
    if (!this.#panel.classList.contains('is-open')) return
    if (this.#labelTimeout) clearTimeout(this.#labelTimeout)
    this.#labelTimeout = setTimeout(() => {
      const ctx = this.#ws.getSelectionContext()
      const t = ctx && ctx.target
      if (!t || !this.#label) return
      this.#label.textContent = t.label === 'Follow-up' ? 'Ask Follow-up' : 'Ask About ' + t.label
    }, 100)
  }
}
