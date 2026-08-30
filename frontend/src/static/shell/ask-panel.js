// @ts-check
// The Ask panel as a PERMANENT Workspace child, constructed ONCE and persisting
// across tab/editor switches, so it is NOT owned by any editor. It REFLECTS the
// active editor by subscribing to workspace.onSelectionUpdate.
//
// The message is written in a COMPOSER MOUNT — a lens over an in-memory draft —
// so what leaves here on send is the list of blocks that were written, not a
// line of text. The panel still does NO position or protocol work of its own:
// it passes the SelectionContext it LAST RENDERED into the footer's target
// chip and never a live re-read, so send acts on exactly what was shown.
// The editor owns the doc mutation.

import { CommandCue } from './command-cue.js'
import { ComposerAttachments } from './composer-attachments.js'
import { ComposerHints } from './composer-hints.js'
import { ComposerMount } from './composer-mount.js'
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
  /** @type {ComposerMount|null} the draft the message is written in — the panel's
   *  ONE socket, and the same one #102's chat will take. */
  #composer = null
  /** @type {ComposerAttachments|null} the chip row over what the message being
   *  written has attached. A VIEW of the draft's own elements — the panel keeps
   *  no list of its own. */
  #attachments = null
  /** @type {ComposerHints|null} the footer's view of what the draft answers to,
   *  derived from the spec the mounted lens publishes. */
  #hints = null
  /** @type {TargetChips|null} the footer's view of what the message will ACT ON.
   *  A separate concern from #attachments and deliberately so: the editor owns the
   *  selection this draws, so it never enters a manifest. */
  #targetChips = null
  /** @type {CommandCue|null} the footer's view of WHICH WAY SEND WILL GO, drawn
   *  from the same predicate the send branch is taken on. */
  #cue = null
  /** @type {HTMLElement|null} the structural #ask-panel (null → all methods no-op) */
  #panel = null
  /** @type {boolean} pin state — one persisted boolean (ShowAskPanel), mirrored here */
  #pinned = false
  /** @type {ReturnType<typeof setTimeout>|null} debounce for the pulled-context repaint */
  #labelTimeout = null
  /** @type {ReturnType<typeof setTimeout>|null} debounce for the command-cue repaint */
  #cueTimeout = null
  /** @type {import('../lens/document-editor/selection-model.js').SelectionContext|null} focus coordinate pulled on jump-in */
  #focusReturn = null
  /** @type {import('../lens/document-editor/selection-model.js').SelectionContext|null} the context CURRENTLY shown in the target chip — what send acts on */
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
   * @param {ComposerMount} [composer] the draft socket. The panel builds one over
   *   its own fixture when none is given; a caller supplies one to mount the same
   *   panel over a different arrangement.
   */
  constructor(ws, commandService, badges, mentionService, composer) {
    this.#ws = ws
    this.#commandService = commandService || (ws && /** @type {any} */ (ws).commandService) || null
    this.#mentionService = mentionService || (ws && /** @type {any} */ (ws).mentionService) || null
    this.#badges = badges || (ws && /** @type {any} */ (ws).commandBadges) || null
    this.#panel = document.getElementById('ask-panel')
    this.#pinned = !!window.initAskPanelPinned
    if (!this.#panel) return
    // The composer is the SOCKET, and it comes first: the chips are a view of the
    // message it holds, so they need it to read from.
    this.#composer = composer || new ComposerMount(this.#panel.querySelector('.ask-popup__input'), {
      mentionService: this.#mentionService,
      commandService: this.#commandService,
      macroCatalog: (ws && /** @type {any} */ (ws).macroCatalog) || null,
    })
    // The hint row takes the footer's left edge, so it is built FIRST — it
    // inserts at the front, and both chip rows insert before Send.
    this.#hints = new ComposerHints(this.#panel.querySelector('.ask-popup__footer'))
    // The target row is built next so it lands left of the attachment chips: what
    // the message acts on, then what it drags along. View-only — the editor owns
    // the selection it draws.
    this.#targetChips = new TargetChips(this.#panel.querySelector('.ask-popup__footer'))
    // The attachment chips come next: the `@` provider's accept-sink writes
    // through them, so they must exist before the picker can offer anything.
    // They take the composer whole — an attachment's element and its `@Title`
    // token both live in the draft, and the chips are a VIEW of the pair.
    this.#attachments = new ComposerAttachments(
      this.#panel.querySelector('.ask-popup__footer'), this.#composer,
    )
    // The command cue comes last, so it sits against Send: it is what Send is
    // about to do.
    this.#cue = new CommandCue(this.#panel.querySelector('.ask-popup__footer'))
    this.#wireComposer()
    this.#wireDom()
    this.#wirePinToggle()
    this.#wireGlobalHotkey()
    this.#wireAiEvents()
    // The workspace republishes only the active tab and synthesizes on
    // tab-switch, so the target chip refreshes on caret move, focus change AND
    // tab change.
    this.#ws.onSelectionUpdate((ctx) => this.#onSelectionUpdate(ctx))
    // INVARIANT: whenever the panel is VISIBLE, the draft is MOUNTED. A pinned
    // panel is visible from the server-rendered `is-open` class before open()
    // ever runs — mount now so the socket is never empty. Not a jump-in, so it
    // must not touch #focusReturn/#lastContext or steal focus.
    if (this.#panel.classList.contains('is-open')) this.#openComposer()
  }

  /** Brings the draft into being and republishes what the footer says about it.
   *  Idempotent, and the ONLY way the panel opens a composer: the hints are
   *  derived from the mounted lens's spec, so they cannot be drawn before there
   *  is a lens to ask, and no call site may forget to ask. */
  #openComposer() {
    if (!this.#composer) return
    this.#composer.open()
    if (this.#hints) this.#hints.show(this.#composer.capabilities())
    // A draft kept across a close may already be a command, so the cue is drawn
    // from the message rather than reset with the panel.
    this.#paintCue()
  }

  /** Opens the Ask box: toggle-out if it already has focus, else pull the focus
   *  coordinate for jump-out, show, seed the target chip and focus the draft.
   *  Focus and pin are independent axes. */
  open() {
    if (!this.#panel || !this.#composer) return
    if (this.#panel.classList.contains('is-open') && this.#composer.hasFocus()) {
      this.close()
      return
    }
    // The draft is brought into being on the first open and kept across closes:
    // a message half-written when the panel was dismissed is still being written.
    this.#openComposer()
    // Jump IN: pull where focus was so jump-out restores it exactly. Must run
    // before the composer steals focus below.
    this.#focusReturn = this.#ws.getSelectionContext()
    // Seed the send context so an immediate send, before the first debounced
    // repaint, still acts on what is shown.
    this.#lastContext = this.#focusReturn
    this.#panel.classList.add('is-open')
    // Paint what we already know before the debounced pull confirms it: the target
    // chip must not arrive 100ms after the panel it belongs to.
    this.#renderSubject()
    this.#refreshLabel()
    const composer = this.#composer
    setTimeout(() => composer.focus(), 50)
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
    if (this.#panel && this.#panel.classList.contains('is-open') &&
        this.#composer && this.#composer.hasFocus()) {
      this.close()
    } else {
      this.open()
    }
  }

  /** Run an explain job over the active editor's CURRENT selection context.
   *  Explain is caret-contextual, so "what is at the caret now" IS the target
   *  and no target chip is involved. The editor owns the markdown abort. */
  explainActive() {
    const ed = this.#activeEditor()
    if (ed) ed.askAi({ type: 'explain', context: ed.getSelectionContext() })
  }

  /** @returns {ComposerMount|null} the draft socket this panel writes in */
  get composer() { return this.#composer }

  /** @returns {any} the live active editor, or null */
  #activeEditor() {
    return (this.#ws.activeTab && this.#ws.activeTab.editor) || null
  }

  /**
   * Takes up the composer's three streams.
   *
   * SUBMIT is the composer's gesture and the panel's decision: the lens says the
   * message is finished, and everything about what that COSTS — command or ask,
   * which editor receives it, what clears — stays here.
   *
   * LIVE RECONCILIATION: the chips are a VIEW of the `@Title` tokens, so every
   * edit redraws them — reconciling only at send let the UI claim "attached"
   * right up until it silently was not.
   */
  #wireComposer() {
    const composer = /** @type {ComposerMount} */ (this.#composer)
    composer.onSubmit(() => this.#send())
    composer.onMention((c) => {
      if (this.#attachments) this.#attachments.add(c)
      this.#markMentions()
    })
    composer.onChanged(() => {
      this.#reconcileChips()
      this.#renderSubject()
      this.#refreshCue()
    })
    // A token and its element are ONE object, so the draft's ask to detach is
    // answered exactly as the chip's ✕ is.
    composer.onDetachRequest((title) => this.#detach(title))
    composer.onClearRequest(() => this.#clearDraft())
  }

  /** Detaches the document named `title` — the ✕ path, reached from the token
   *  instead of the chip. Titles are how a token names its document, so where
   *  two attachments share one the first is detached; the two are indis-
   *  tinguishable to whoever clicked. @param {string} title */
  #detach(title) {
    if (!this.#attachments) return
    const hit = this.#attachments.manifest().find((a) => a.title === title)
    if (hit) this.#attachments.remove(hit.uri)
  }

  /** Empties the message being written: a fresh draft, its attachments gone with
   *  it, and the caret back in it. Clearing is not dismissing — the panel stays
   *  open and the target chip, which describes the editor rather than the
   *  message, stays as it is. */
  #clearDraft() {
    if (this.#composer) {
      this.#composer.reset()
      this.#composer.focus()
    }
    this.#reconcileChips()
    this.#paintCue()
  }

  /** Binds send / Escape onto the structural #ask-panel. There is no ✕ button —
   *  the panel has no header — so #dismiss is reached only via Escape and the
   *  View-menu pin toggle (#wirePinToggle). Escape is bound at the panel and NOT
   *  claimed by the composer mount, so an open picker — which stops the event at
   *  the surface — still gets first refusal on it. */
  #wireDom() {
    const panel = /** @type {HTMLElement} */ (this.#panel)
    const sendBtn = panel.querySelector('.ask-popup__send')

    if (sendBtn) sendBtn.addEventListener('click', () => this.#send())

    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      this.#dismiss()
    })
  }

  /** Re-derives the chips from the message as written, and the marks in the
   *  message from the chips — one derivation, in that order, because a chip is
   *  what makes a `@Title` a mention rather than words that begin with an @. */
  #reconcileChips() {
    if (this.#attachments) this.#attachments.reconcile(this.#composerText())
    this.#markMentions()
  }

  /** Tells the draft which titles are attached, so it marks their tokens. Which
   *  ones those are is the chips' reading of the draft, so the panel is what
   *  says this — the lens holds no view of what a message drags along. */
  #markMentions() {
    if (this.#composer && this.#attachments) {
      this.#composer.setMentionTitles(this.#attachments.titles())
    }
  }

  /** @returns {string} the message as written ('' before the first open) */
  #composerText() { return this.#composer ? this.#composer.read() : '' }

  /** Reflects the persisted View-menu toggle onto the panel's open state. */
  #wirePinToggle() {
    document.addEventListener('sieve:ask-panel-toggled', (e) => {
      this.#pinned = /** @type {CustomEvent} */ (e).detail
      if (!this.#panel) return
      if (this.#pinned) {
        this.#panel.classList.add('is-open')
        // Pinning ON makes the panel visible without a jump-in: mount the draft
        // so the socket is never empty, without stealing focus.
        this.#openComposer()
      } else if (!this.#composer || !this.#composer.hasFocus()) {
        this.#panel.classList.remove('is-open')
      }
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

  /**
   * SEND: hand the question plus the context the panel LAST RENDERED to the ONE
   * editor seam, which owns everything doc-facing. Passing the shown context,
   * never a live re-read, is what makes send act on what the target chip showed.
   *
   * THE HARVEST IS TAKEN ONCE, ahead of the branch, and both paths read the same
   * draft: a message that resolves to a command is the same message either way,
   * and one that does not travels as the LIST OF BLOCKS it was written as —
   * attachments included, since they are blocks of it.
   */
  #send() {
    if (!this.#composer) return
    if (!this.#composer.read().trim()) return

    // The draft is SETTLED first: an attachment whose `@Title` token the user
    // deleted leaves it here, because deleting the text is a legitimate way to
    // detach. ONE call site ahead of the harvest, so the two send paths cannot
    // settle differently.
    const attachments = this.#attachments ? this.#attachments.commit() : []
    const written = this.#composer.harvest()

    // The SAME predicate the footer has been painting, asked once more against
    // the settled draft — so what Send does is what the cue said it would.
    const command = this.#resolveDraftCommand(written)
    const cs = this.#commands()
    if (command && cs) {
      const context = this.#lastContext || (this.#ws ? this.#ws.getSelectionContext() : null)
      // No onResult here: the CommandBadge wires its own listener off the
      // handle. attachments and body ride as TOP-LEVEL siblings of context on
      // the frame — Go reads each as its own field.
      const handle = cs.dispatch(
        command.cmd.name, command.text, context, undefined, attachments, command.body,
      )
      const badges = this.#badges || (this.#ws && /** @type {any} */ (this.#ws).commandBadges)
      if (badges) {
        badges.track(handle, { cmd: command.cmd.name, text: command.text })
      }
      this.#clearComposer()
      return
    }

    const ed = this.#activeEditor()
    if (!ed) return
    const context = this.#lastContext || ed.getSelectionContext()
    // NO separate attachments: the harvested list already carries them as the
    // reference elements they are, and a second copy would arrive twice.
    ed.askAi({ type: 'ask', question: written, context })
    this.#clearComposer()
  }

  /**
   * THE PREDICATE. What command this draft resolves to — the ONE reading of it,
   * used both to paint the footer and to take the send branch, so the two can
   * never disagree.
   *
   * A draft is a command when its FIRST element that is not a reference is prose
   * opening at position 0 with a `/verb` the registry knows. References are
   * skipped because a `@Title` written before the verb is an attachment, not the
   * head of the message. `/usr/bin/thing` resolves to no verb and is therefore a
   * question about a path.
   *
   * EVERYTHING AFTER THE VERB IS THE MESSAGE, never a demotion, and it is
   * carried as TWO COMPLETE PROJECTIONS of that one message — the flavors a
   * clipboard would call text/plain and its structured form:
   *
   *   - `text` is the composer's raw plaintext with the verb removed;
   *   - `body` is the same message as the blocks it was written as, in order,
   *     references included. The rest of the verb's own line stays the head
   *     element, keeping its authored id; a line that was only the verb
   *     contributes nothing and is dropped.
   *
   * Neither projection is derived from the other anywhere downstream: both are
   * authored here, from the same draft in the same reading, and a command
   * consumes whichever makes sense for it.
   * @param {ReadonlyArray<import('../renderers/question-list.js').QuestionElement>} elements
   * @returns {{cmd: {name: string, description?: string}, text: string,
   *   body: Array<import('../renderers/question-list.js').QuestionElement>}|null}
   */
  #resolveDraftCommand(elements) {
    const cs = this.#commands()
    if (!cs) return null
    const at = elements.findIndex((el) => el.kind !== 'reference')
    if (at < 0 || elements[at].kind !== 'prose') return null
    const content = String((elements[at].attrs && elements[at].attrs.content) || '')
    if (!content.startsWith('/')) return null
    const resolved = cs.resolve(content)
    if (!resolved) return null
    // The verb as it actually sits in the draft: the slash, any space the
    // resolver tolerated after it, and the name — what both flavors strip.
    const afterSlash = content.slice(1)
    const verbToken = content.slice(
      0, 1 + (afterSlash.length - afterSlash.trimStart().length) + resolved.cmd.name.length,
    )
    const remainder = content.slice(verbToken.length).trim()
    // The verb element is REPLACED in place by its remainder, so an element
    // written before it — a reference — keeps its position in the message.
    const body = elements.flatMap((el, i) => {
      if (i !== at) return [el]
      if (remainder === '') return []
      return [{ kind: 'prose', attrs: { ...el.attrs, content: remainder } }]
    })
    return {
      cmd: resolved.cmd,
      text: this.#plainTextMinusVerb(verbToken),
      body: body,
    }
  }

  /** The message as the composer's own text/plain projection, with the one
   *  verb token removed from the line it opens. @param {string} verbToken
   *  @returns {string} */
  #plainTextMinusVerb(verbToken) {
    const lines = (this.#composer ? this.#composer.read() : '').split('\n')
    const at = lines.findIndex((l) => l.startsWith(verbToken))
    if (at >= 0) lines[at] = lines[at].slice(verbToken.length).replace(/^\s+/, '')
    return lines.join('\n').trim()
  }

  /** Repaints the command cue once typing settles. Debounced on the same beat as
   *  the target chip, because the reading behind it FLUSHES the draft — the cue
   *  must describe the harvest the send will take, not the one the container had
   *  500ms ago. */
  #refreshCue() {
    if (this.#cueTimeout) clearTimeout(this.#cueTimeout)
    this.#cueTimeout = setTimeout(() => this.#paintCue(), 100)
  }

  /** Draws what the draft currently resolves to: the footer's badge, Send's own
   *  label, and the `/verb` token's mark in the message. */
  #paintCue() {
    if (!this.#composer) return
    const command = this.#resolveDraftCommand(this.#composer.harvest())
    if (this.#cue) this.#cue.show(command ? command.cmd : null)
    this.#composer.setCommandVerb(command ? command.cmd.name : null)
  }

  /** Retires the draft after a send: a new container, a new lens, and no undo
   *  history reaching back into a message already sent. The picker's abandonment
   *  record dies with the lens, so a document created mid-session is findable
   *  again on the next message. */
  #clearComposer() {
    if (this.#composer) this.#composer.reset()
    this.#reconcileChips()
    this.#paintCue()
    if (this.#panel && !this.#pinned) this.#panel.classList.remove('is-open')
    this.#focusReturn = null
    // The target chip stays — the selection outlives the message.
    this.#renderSubject()
  }

  /**
   * On a meaningful selection change, re-render the target chip when the panel
   * is open.
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
    if (!this.#panel) return
    if (!this.#panel.classList.contains('is-open')) return
    if (this.#labelTimeout) clearTimeout(this.#labelTimeout)
    this.#labelTimeout = setTimeout(() => {
      this.#lastContext = this.#ws.getSelectionContext()
      this.#renderSubject()
    }, 100)
  }

  /**
   * Renders the footer's target chip — what #lastContext, and so a send, would
   * act on — and points the block-freshness watch at its container. There is no
   * header to name a command in: the panel has none, so a message that resolves
   * to one is named only by the command dispatch itself at send.
   */
  #renderSubject() {
    if (!this.#panel) return
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

  /** @returns {import('./command-service.js').CommandService|null} the injected service, or the workspace's */
  #commands() {
    return this.#commandService || (this.#ws && /** @type {any} */ (this.#ws).commandService) || null
  }
}
