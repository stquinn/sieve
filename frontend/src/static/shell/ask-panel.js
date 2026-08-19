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
// null-guards a missing panel (headless boot / vitest import). D-5 (P4.E): the
// panel is DUMB UI — it holds NO tiptap and does NO position/protocol work. On send
// it passes the SelectionContext it LAST RENDERED (the label the user saw) to the
// ONE editor seam editor.askAi({type,question,context}); the editor owns the target
// highlight, insert index, flush, block creation, and cursor. Passing the shown
// context (never a live re-read) is the D-5 anti-race: send acts on exactly what the
// label described. The Ask-panel FOCUS GLOW was DROPPED in P4.B — panel paints nothing.
//
// Dual-use ES module: imported by workspace.js (which constructs it). No window.*
// export — the singleton is reached via window.sieveWorkspace.askPanel.

import { TriggerPopover } from './trigger-popover.js'
import { SlashCommandProvider, MentionProvider } from './trigger-providers.js'
import { TextareaHost, PanelPlacement } from './trigger-host.js'
import { ComposerAttachments } from './composer-attachments.js'
import { TargetChips } from './target-chips.js'

export class AskPanel {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {import('../block/command-service.js').CommandService|null} */
  #commandService = null
  /** @type {import('../block/mention-service.js').MentionService|null} */
  #mentionService = null
  /** @type {import('./command-badges.js').CommandBadges|null} */
  #badges = null
  /** @type {TriggerPopover|null} */
  #hintPopover = null
  /** @type {ComposerAttachments|null} what the message being written has attached
   *  (#74). PANEL STATE — the chips are UI, the manifest is what send carries. */
  #attachments = null
  /** @type {TargetChips|null} the footer's view of what the message will ACT ON
   *  (#74). A separate concern from #attachments and deliberately so: the editor
   *  owns the selection this draws, so it never enters a manifest. */
  #targetChips = null
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
  /** @type {import('../editor/selection-model.js').SelectionContext|null} focus coordinate pulled on jump-in */
  #focusReturn = null
  /** @type {import('../editor/selection-model.js').SelectionContext|null} the context whose label is CURRENTLY shown — what send acts on (D-5: send == shown) */
  #lastContext = null

  /**
   * @param {import('./workspace.js').SieveWorkspace} ws
   * @param {import('../block/command-service.js').CommandService} [commandService]
   * @param {import('./command-badges.js').CommandBadges} [badges]
   * @param {import('../block/mention-service.js').MentionService} [mentionService]
   */
  constructor(ws, commandService, badges, mentionService) {
    this.#ws = ws
    this.#commandService = commandService || (ws && /** @type {any} */ (ws).commandService) || null
    this.#mentionService = mentionService || (ws && /** @type {any} */ (ws).mentionService) || null
    this.#badges = badges || (ws && /** @type {any} */ (ws).commandBadges) || null
    this.#panel = document.getElementById('ask-panel')
    this.#pinned = !!window.initAskPanelPinned
    if (!this.#panel) return
    this.#textarea = this.#panel.querySelector('.ask-popup__input')
    this.#label = this.#panel.querySelector('.ask-popup__label')
    // The target row is built FIRST so it lands left of the attachment chips:
    // what the message acts on, then what it drags along. It is view-only and
    // holds no model — the editor owns the selection it draws.
    this.#targetChips = new TargetChips(this.#panel.querySelector('.ask-popup__footer'))
    // The attachment model comes next: the `@` provider's accept-sink writes
    // into it, so it must exist before the picker can offer anything. It takes
    // the composer too — the `@Title` tokens live there and the chips are a VIEW
    // of them (#74 P6) — and the gate through which it edits that text. The gate
    // is late-bound because the picker it defers to is built below.
    this.#attachments = new ComposerAttachments(
      this.#panel.querySelector('.ask-popup__footer'),
      this.#textarea,
      (edit) => this.#applyOwnEdit(edit),
    )
    // ONE picker, two triggers (#74 P4): `/` enumerates the boot-shipped command
    // list, `@` round-trips the library through the session plane. The popover
    // owns the keyboard model, each provider owns only its own trigger, and the
    // HOST owns the surface — here the textarea, placed as an extension of the
    // panel above it.
    if (this.#textarea) {
      const providers = []
      if (this.#commandService) providers.push(new SlashCommandProvider(this.#commandService))
      if (this.#mentionService) {
        providers.push(new MentionProvider(this.#mentionService, (c) => this.#attachments?.add(c)))
      }
      if (providers.length) {
        this.#hintPopover = new TriggerPopover(
          new TextareaHost(this.#textarea), providers, new PanelPlacement(),
        )
      }
    }
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
    // Seed the send context to the current selection so an immediate send (before
    // the first debounced label render) still acts on what's shown; #refreshLabel
    // keeps it in lock-step with the label thereafter.
    this.#lastContext = this.#focusReturn
    this.#panel.classList.add('is-open')
    // Paint what we already know before the debounced pull confirms it: the
    // target chip must not arrive 100ms after the panel it belongs to.
    this.#renderSubject()
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
   * Run an explain job on the active editor over its CURRENT selection context
   * (explain is caret-contextual — fired from Mod+E / the context menu / a block
   * affordance, so "what's at the caret now" IS the target; no panel label is
   * involved). The editor owns the markdown abort (askAi no-ops explain in markdown).
   */
  explainActive() {
    const ed = this.#activeEditor()
    if (ed) ed.askAi({ type: 'explain', context: ed.getSelectionContext() })
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
      // ATOMIC TOKEN DELETION (#74 P6). Backspace at the right edge of an
      // accepted `@Title` takes the WHOLE token and its chip, which is what makes
      // the half-broken `@Auth Desig` state unreachable by the ordinary gesture.
      // Anywhere else it falls straight through — the key is only ever borrowed.
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && this.#detachTokenAtCaret()) {
        e.preventDefault()
        return
      }
      // Ctrl+Shift+A (jump back out) is the global hotkey — only Enter/Escape are box-local.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.#send() }
      if (e.key === 'Escape') { e.preventDefault(); this.#dismiss() }
    })

    // LIVE RECONCILIATION (#74 P6): the chips are a VIEW of the `@Title` tokens
    // in the message, so every edit path — typing, selecting through a token and
    // deleting, cut, paste-over, undo — redraws them. Reconciling only at send
    // was the defect: the UI claimed "attached" right up until it silently
    // wasn't. The HEADER is derived from the same text on the same event and for
    // the same reason (#74): a label set once when the panel opened would go on
    // saying "Ask About …" over a `/btw` the user has already typed.
    textarea.addEventListener('input', () => {
      this.#reconcileChips()
      this.#renderSubject()
    })
  }

  /** Re-derives the chips from the message as written. */
  #reconcileChips() {
    if (this.#textarea && this.#attachments) this.#attachments.reconcile(this.#textarea.value)
  }

  /**
   * Deletes the whole attachment token the caret sits at the right edge of.
   * A SELECTION deletes itself — Backspace over one is not a token gesture.
   * @returns {boolean} whether the keypress was consumed
   */
  #detachTokenAtCaret() {
    const textarea = this.#textarea
    if (!textarea || !this.#attachments) return false
    if (textarea.selectionStart !== textarea.selectionEnd) return false
    return this.#attachments.detachAt(textarea.selectionStart)
  }

  /**
   * Performs a programmatic edit of the composer text as OUR write: the picker
   * ignores the `input` it fires, so deleting a token neither reopens the picker
   * on the deleted token nor disturbs the abandonment record. Same guard
   * acceptance uses — there is one notion of "our own edit", not two.
   * @param {() => void} edit
   */
  #applyOwnEdit(edit) {
    if (this.#hintPopover) this.#hintPopover.applyOwnEdit(edit)
    else edit()
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
   * The Mod+Shift+A entry. D-5: the Ask panel owns this chord WHOLESALE — the editor
   * keymap no longer binds it (AiShortcuts.onAsk removed), so this document-level
   * listener handles every case, including when the main editor has focus. It is
   * still not hijacked inside the sidebar or a modal dialog. No tiptap reach.
   */
  #wireGlobalHotkey() {
    document.addEventListener('keydown', (e) => {
      if ((e.key !== 'a' && e.key !== 'A') || !window.isMod(e) || !e.shiftKey || e.altKey) return
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
   * SEND: hand the question + the context the panel LAST RENDERED (the label the
   * user saw) to the ONE editor seam. The editor owns EVERYTHING doc-facing — the
   * == target highlight, the block insert index, the flush, the ai-block creation,
   * and the post-send cursor collapse. The panel touches NO tiptap and does NO
   * position/protocol work; passing the shown context (never a live re-read) is the
   * D-5 anti-race — send acts on exactly what the label described.
   */
  #send() {
    if (!this.#textarea) return
    const val = this.#textarea.value.trim()
    if (!val) return

    // SEND-TIME RECONCILIATION (#74 P4): an attachment whose `@Title` token the
    // user deleted from the message is dropped here — deleting the text is a
    // legitimate way to detach. Both send paths carry the SAME manifest shape.
    //
    // ONE call site, ahead of the branch, deliberately: the two send paths must
    // not be able to reconcile differently. It prunes the model, so a send that
    // then aborts (no active editor) leaves the chips agreeing with the text
    // that is still in the box — which is the state the user would have seen
    // anyway, not a loss.
    const attachments = this.#attachments ? this.#attachments.reconcile(this.#textarea.value) : []

    if (val.startsWith('/')) {
      const cs = this.#commands()
      if (cs) {
        const resolved = cs.resolve(val)
        if (resolved) {
          const context = this.#lastContext || (this.#ws ? this.#ws.getSelectionContext() : null)
          // No onResult here: the CommandBadge wires its own listener off the
          // handle (handle.onResult) and owns the answer lifecycle. There is no
          // editor.handleCommandResult seam — command results land in the badge/
          // popup, never back in the editor doc.
          // attachments ride as a TOP-LEVEL sibling of context on the frame, not
          // inside it — Go reads them as their own field (see CommandService).
          const handle = cs.dispatch(resolved.cmd.name, resolved.args, context, undefined, attachments)
          const badges = this.#badges || (this.#ws && /** @type {any} */ (this.#ws).commandBadges)
          if (badges) {
            badges.track(handle, { cmd: resolved.cmd.name, text: resolved.args })
          }
          this.#clearComposer()
          return
        }
      }
    }

    const ed = this.#activeEditor()
    if (!ed) return
    const context = this.#lastContext || ed.getSelectionContext()
    ed.askAi({ type: 'ask', question: val, context, attachments })
    this.#clearComposer()
  }

  /** Resets the composer after a send: the box, the chips, the picker's memory of
   *  the token the user walked away from, the focus coordinate. The abandonment
   *  record is keyed to an index in text that no longer exists, and outliving the
   *  send would keep a document created mid-session unfindable (#74 P6). */
  #clearComposer() {
    if (this.#textarea) this.#textarea.value = ''
    if (this.#attachments) this.#attachments.clear()
    if (this.#hintPopover) this.#hintPopover.reset()
    if (this.#panel && !this.#pinned) this.#panel.classList.remove('is-open')
    this.#focusReturn = null
    // The header is a view of the text, and the text is gone: an emptied composer
    // names no command, so the subject goes back to being the target. (The target
    // chip stays — the selection outlives the message.)
    this.#renderSubject()
  }

  /**
   * The P3.D boot closure, now OWNED here: on a meaningful selection change,
   * re-render the label when the panel is open. NO glow (dropped in P4.B).
   * @param {import('../editor/selection-model.js').SelectionContext|null} ctx
   */
  #onSelectionUpdate(ctx) {
    if (!ctx) return
    if (this.#panel && this.#panel.classList.contains('is-open')) this.#refreshLabel()
  }

  /**
   * Debounced re-render from the live target (pull at refresh, F2). It also
   * STORES the pulled context as #lastContext, so #send acts on exactly the
   * context the panel is describing (D-5: send == shown).
   */
  #refreshLabel() {
    if (!this.#panel || !this.#label) return
    if (!this.#panel.classList.contains('is-open')) return
    if (this.#labelTimeout) clearTimeout(this.#labelTimeout)
    this.#labelTimeout = setTimeout(() => {
      this.#lastContext = this.#ws.getSelectionContext()
      this.#renderSubject()
    }, 100)
  }

  /**
   * Renders the two things the panel says about a send: the HEADER (the SUBJECT —
   * the command being invoked, or Ask and what it is about) and the footer's
   * target chip (the CONTEXT that subject will receive).
   *
   * Both are DERIVED, never set-and-left. The header is a view of the composer
   * text exactly as the attachment chips are, so it names a command the moment
   * the text resolves to one and reverts the moment that token goes — no send,
   * no selection event needed. It swaps only on an EXACT match against a known
   * command, or it would flicker through `/b`, `/bt` on the way to `/btw`.
   *
   * The target chip is drawn from #lastContext (the context a send would carry),
   * never a live re-read, so what is on screen and what would be sent cannot
   * disagree.
   */
  #renderSubject() {
    if (!this.#panel || !this.#label) return
    const cmd = this.#activeCommand()
    const target = this.#lastContext && this.#lastContext.target
    if (cmd) {
      this.#label.textContent = '/' + cmd.name
    } else if (target) {
      this.#label.textContent = target.label === 'Follow-up' ? 'Ask Follow-up' : 'Ask About ' + target.label
    }
    if (this.#targetChips) this.#targetChips.show(this.#lastContext)
  }

  /**
   * The KNOWN command the composer names right now, or null. Resolution is the
   * CommandService's — one place decides what a command is, and "known" means
   * exactly what dispatch means by it.
   * @returns {import('../block/command-service.js').CommandDescriptor|null}
   */
  #activeCommand() {
    const cs = this.#commands()
    const resolved = cs && this.#textarea ? cs.resolve(this.#textarea.value) : null
    return resolved ? resolved.cmd : null
  }

  /** @returns {import('../block/command-service.js').CommandService|null} the injected service, or the workspace's */
  #commands() {
    return this.#commandService || (this.#ws && /** @type {any} */ (this.#ws).commandService) || null
  }
}
