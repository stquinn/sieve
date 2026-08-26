// @ts-check
// The Ask panel as a PERMANENT Workspace child, constructed ONCE and persisting
// across tab/editor switches, so it is NOT owned by any editor. It REFLECTS the
// active editor by subscribing to workspace.onSelectionUpdate.
//
// The panel is DUMB UI: it holds NO tiptap and does NO position or protocol work.
// On send it passes the SelectionContext it LAST RENDERED — the label the user
// saw — and never a live re-read, so send acts on exactly what the label
// described. The editor owns the doc mutation.

import { TriggerPopover } from './trigger-popover.js'
import { SlashCommandProvider, MentionProvider } from './trigger-providers.js'
import { TextareaHost, PanelPlacement } from './trigger-host.js'
import { ComposerAttachments } from './composer-attachments.js'
import { TargetChips } from './target-chips.js'

export class AskPanel {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {import('./command-service.js').CommandService|null} */
  #commandService = null
  /** @type {import('./mention-service.js').MentionService|null} */
  #mentionService = null
  /** @type {import('./command-badges.js').CommandBadges|null} */
  #badges = null
  /** @type {TriggerPopover|null} */
  #hintPopover = null
  /** @type {ComposerAttachments|null} what the message being written has
   *  attached. PANEL STATE — the chips are UI, the manifest is what send carries. */
  #attachments = null
  /** @type {TargetChips|null} the footer's view of what the message will ACT ON.
   *  A separate concern from #attachments and deliberately so: the editor owns the
   *  selection this draws, so it never enters a manifest. */
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
  /** @type {import('../lens/document-editor/selection-model.js').SelectionContext|null} focus coordinate pulled on jump-in */
  #focusReturn = null
  /** @type {import('../lens/document-editor/selection-model.js').SelectionContext|null} the context whose label is CURRENTLY shown — what send acts on */
  #lastContext = null
  /** @type {string} the container whose truth the target chips are watching */
  #watchedUuid = ''
  /** @type {(() => void)|null} unsubscribe for that watch */
  #unwatchBlocks = null

  /**
   * @param {import('./workspace.js').SieveWorkspace} ws
   * @param {import('./command-service.js').CommandService} [commandService]
   * @param {import('./command-badges.js').CommandBadges} [badges]
   * @param {import('./mention-service.js').MentionService} [mentionService]
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
    // The target row is built FIRST so it lands left of the attachment chips: what
    // the message acts on, then what it drags along. View-only — the editor owns
    // the selection it draws.
    this.#targetChips = new TargetChips(this.#panel.querySelector('.ask-popup__footer'))
    // The attachment model comes next: the `@` provider's accept-sink writes into
    // it, so it must exist before the picker can offer anything. It also takes the
    // composer, since the `@Title` tokens live there and the chips are a VIEW of
    // them, plus the gate through which it edits that text.
    this.#attachments = new ComposerAttachments(
      this.#panel.querySelector('.ask-popup__footer'),
      this.#textarea,
      (edit) => this.#applyOwnEdit(edit),
    )
    // ONE picker, two triggers: `/` enumerates the boot-shipped command list, `@`
    // round-trips the library. The popover owns the keyboard model, each provider
    // its own trigger, and the HOST the surface.
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
    // The workspace republishes only the active tab and synthesizes on
    // tab-switch, so the label refreshes on caret move, focus change AND tab
    // change.
    this.#ws.onSelectionUpdate((ctx) => this.#onSelectionUpdate(ctx))
  }

  /** Opens the Ask box: toggle-out if it already has focus, else pull the focus
   *  coordinate for jump-out, show, seed the label and focus the textarea. Focus
   *  and pin are independent axes. */
  open() {
    if (!this.#panel || !this.#textarea) return
    if (this.#panel.classList.contains('is-open') && document.activeElement === this.#textarea) {
      this.close()
      return
    }
    // Jump IN: pull where focus was so jump-out restores it exactly. Must run
    // before the textarea steals focus below.
    this.#focusReturn = this.#ws.getSelectionContext()
    // Seed the send context so an immediate send, before the first debounced label
    // render, still acts on what is shown.
    this.#lastContext = this.#focusReturn
    this.#panel.classList.add('is-open')
    // Paint what we already know before the debounced pull confirms it: the target
    // chip must not arrive 100ms after the panel it belongs to.
    this.#renderSubject()
    this.#refreshLabel()
    const ta = this.#textarea
    setTimeout(() => ta.focus(), 50)
  }

  /** Jumps back to the editor, hiding the panel if unpinned and restoring the
   *  caret to where we were on jump-in. A jump-out NEVER touches the persisted
   *  pin state. */
  close() {
    if (!this.#panel) return
    if (!this.#pinned) this.#panel.classList.remove('is-open')
    this.#ws.setPosition(this.#focusReturn)
  }

  /** Dismisses the panel. "View Ask panel on/off" and "pin" are ONE persisted
   *  boolean, so when pinned ON, ✕ untoggles it through the same endpoint the View
   *  menu uses; a transient ambient open just hands focus back and hides. */
  #dismiss() {
    if (this.#pinned && window.htmx) {
      window.htmx.ajax('POST', '/api/session/toggle/askpanel', { swap: 'none' })
    }
    this.close()
  }

  /** Focus-agnostic toggle: if the box has focus, jump back out; otherwise in. */
  toggle() {
    if (this.#panel && this.#panel.classList.contains('is-open') && document.activeElement === this.#textarea) {
      this.close()
    } else {
      this.open()
    }
  }

  /** Run an explain job over the active editor's CURRENT selection context.
   *  Explain is caret-contextual, so "what is at the caret now" IS the target and
   *  no panel label is involved. The editor owns the markdown abort. */
  explainActive() {
    const ed = this.#activeEditor()
    if (ed) ed.askAi({ type: 'explain', context: ed.getSelectionContext() })
  }

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
      // ATOMIC TOKEN DELETION. Backspace at the right edge of an accepted `@Title`
      // takes the WHOLE token and its chip, which makes the half-broken
      // `@Auth Desig` state unreachable. Anywhere else it falls straight through.
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && this.#detachTokenAtCaret()) {
        e.preventDefault()
        return
      }
      // Ctrl+Shift+A (jump back out) is the global hotkey; only Enter/Escape are box-local.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.#send() }
      if (e.key === 'Escape') { e.preventDefault(); this.#dismiss() }
    })

    // LIVE RECONCILIATION: the chips are a VIEW of the `@Title` tokens, so every
    // edit path redraws them — reconciling only at send let the UI claim
    // "attached" right up until it silently was not. The HEADER is derived from
    // the same text on the same event, or a label set once when the panel opened
    // would go on saying "Ask About …" over a `/btw` already typed.
    textarea.addEventListener('input', () => {
      this.#reconcileChips()
      this.#renderSubject()
    })
  }

  /** Re-derives the chips from the message as written. */
  #reconcileChips() {
    if (this.#textarea && this.#attachments) this.#attachments.reconcile(this.#textarea.value)
  }

  /** Deletes the whole attachment token the caret sits at the right edge of. A
   *  SELECTION deletes itself — Backspace over one is not a token gesture.
   *  @returns {boolean} whether the keypress was consumed */
  #detachTokenAtCaret() {
    const textarea = this.#textarea
    if (!textarea || !this.#attachments) return false
    if (textarea.selectionStart !== textarea.selectionEnd) return false
    return this.#attachments.detachAt(textarea.selectionStart)
  }

  /** Performs a programmatic edit of the composer text as OUR write: the picker
   *  ignores the `input` it fires, so deleting a token neither reopens the picker
   *  on it nor disturbs the abandonment record. One notion of "our own edit".
   *  @param {() => void} edit */
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

  /** The Mod+Shift+A entry. The Ask panel owns this chord WHOLESALE — the editor
   *  keymap does not bind it — so this document-level listener handles every case,
   *  including when the main editor has focus. Still not hijacked inside the
   *  sidebar or a modal dialog. */
  #wireGlobalHotkey() {
    document.addEventListener('keydown', (e) => {
      if ((e.key !== 'a' && e.key !== 'A') || !window.isMod(e) || !e.shiftKey || e.altKey) return
      const ae = document.activeElement
      if (ae && ae.closest && ae.closest('#htmx-sidebar, dialog')) return
      e.preventDefault()
      this.toggle()
    })
  }

  /** TRANSITIONAL: the sieve:ai-ask / sieve:ai-explain events still ride from the
   *  producers that lack a clean handle to reach this child directly. Their
   *  consumers live HERE, so the single business seam is relocated rather than
   *  split. */
  #wireAiEvents() {
    document.addEventListener('sieve:ai-ask', () => this.open())
    document.addEventListener('sieve:ai-explain', () => this.explainActive())
  }

  /** SEND: hand the question plus the context the panel LAST RENDERED to the ONE
   *  editor seam, which owns everything doc-facing. Passing the shown context,
   *  never a live re-read, is what makes send act on what the label described. */
  #send() {
    if (!this.#textarea) return
    const val = this.#textarea.value.trim()
    if (!val) return

    // SEND-TIME RECONCILIATION: an attachment whose `@Title` token the user
    // deleted is dropped here, because deleting the text is a legitimate way to
    // detach. ONE call site ahead of the branch, so the two send paths cannot
    // reconcile differently.
    const attachments = this.#attachments ? this.#attachments.reconcile(this.#textarea.value) : []

    if (val.startsWith('/')) {
      const cs = this.#commands()
      if (cs) {
        const resolved = cs.resolve(val)
        if (resolved) {
          const context = this.#lastContext || (this.#ws ? this.#ws.getSelectionContext() : null)
          // No onResult here: the CommandBadge wires its own listener off the
          // handle. attachments ride as a TOP-LEVEL sibling of context on the
          // frame — Go reads them as their own field.
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

  /** Resets the composer after a send. The picker's abandonment record is keyed to
   *  an index in text that no longer exists, and outliving the send would keep a
   *  document created mid-session unfindable. */
  #clearComposer() {
    if (this.#textarea) this.#textarea.value = ''
    if (this.#attachments) this.#attachments.clear()
    if (this.#hintPopover) this.#hintPopover.reset()
    if (this.#panel && !this.#pinned) this.#panel.classList.remove('is-open')
    this.#focusReturn = null
    // The header is a view of the text, and the text is gone. The target chip
    // stays — the selection outlives the message.
    this.#renderSubject()
  }

  /**
   * On a meaningful selection change, re-render the label when the panel is open.
   * @param {import('../lens/document-editor/selection-model.js').SelectionContext|null} ctx
   */
  #onSelectionUpdate(ctx) {
    if (!ctx) return
    if (this.#panel && this.#panel.classList.contains('is-open')) this.#refreshLabel()
  }

  /**
   * Debounced re-render from the live target. It also STORES the pulled context as
   * #lastContext, so #send acts on exactly the context the panel is describing.
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
   * Renders the two things the panel says about a send: the HEADER (the SUBJECT)
   * and the footer's target chip (the CONTEXT that subject will receive).
   *
   * Both are DERIVED, never set-and-left. The header is a view of the composer
   * text, so it names a command the moment the text resolves to one and reverts
   * the moment that token goes. It swaps only on an EXACT match, or it would
   * flicker through `/b`, `/bt` on the way to `/btw`.
   *
   * The target chip is drawn from #lastContext — the context a send would carry —
   * so what is on screen and what would be sent cannot disagree.
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
    this.#watchBlocks(this.#lastContext ? this.#lastContext.docUuid : '')
  }

  /** Points the chips' freshness subscription at `uuid`. The chips repaint on
   *  every selection change already; this covers the case where the SELECTION
   *  stands still and a block inside it changes, which no selection event would
   *  announce. @param {string} uuid */
  #watchBlocks(uuid) {
    if ((uuid || '') === this.#watchedUuid) return
    if (this.#unwatchBlocks) this.#unwatchBlocks()
    this.#unwatchBlocks = null
    this.#watchedUuid = uuid || ''
    if (!this.#targetChips) return
    const tab = (this.#ws && /** @type {any} */ (this.#ws).activeTab) || null
    const mount = (tab && tab.mount) || null
    const provider = mount ? mount.provider : null
    this.#targetChips.setSource(provider)
    if (!this.#watchedUuid || !provider) return
    // A SECOND subscriber on the same container, alongside the mounted lens. The
    // model fans out to as many followers as ask for it, which is what lets a
    // panel outside the editor stay current without asking the editor anything.
    const listener = {
      onChanged: (/** @type {any} */ change) => {
        if (this.#targetChips) this.#targetChips.containerChanged(change)
      },
    }
    provider.subscribe(listener)
    this.#unwatchBlocks = () => provider.unsubscribe(listener)
  }

  /**
   * The KNOWN command the composer names right now, or null. Resolution is the
   * CommandService's, so "known" means exactly what dispatch means by it.
   * @returns {import('./command-service.js').CommandDescriptor|null}
   */
  #activeCommand() {
    const cs = this.#commands()
    const resolved = cs && this.#textarea ? cs.resolve(this.#textarea.value) : null
    return resolved ? resolved.cmd : null
  }

  /** @returns {import('./command-service.js').CommandService|null} the injected service, or the workspace's */
  #commands() {
    return this.#commandService || (this.#ws && /** @type {any} */ (this.#ws).commandService) || null
  }
}
