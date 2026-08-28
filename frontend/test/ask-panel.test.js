// ask-panel.test.js — the Ask panel as a PERMANENT Workspace child
// (shell/ask-panel.js), constructed once, wiring the STRUCTURAL #ask-panel DOM
// (index.html) — never rebuilding it. It owns the target-chip debounce, the
// focus round-trip (ws.getSelectionContext/setPosition), the pinned flag, and
// the ws.onSelectionUpdate subscription. On SEND it targets ws.activeTab.editor
// and calls the ONE editor seam (editor.askAi) — never a workspace proxy.
//
// #118 fix round 4: the panel has no header — no label, no ✕ button. The box
// floats, and what it "is asking about" is shown ONLY by the footer's target
// chip; #dismiss is reached via Escape and the View-menu pin toggle.
//
// #118: the message is written in a COMPOSER MOUNT, so what these drive is that
// socket's verbs — read, harvest, submit, reset — and never a textarea. The
// draft's own plumbing is composer-mount.test.js's and the picker's is
// trigger-host-editor.test.js's; what is pinned HERE is the panel, which the
// swap was required to leave intact: the same open/close/pin, the same target
// chips, the same dispatch.

// FIRST: the panel now builds a ComposerMount, so importing it evaluates the
// lens chain, whose side-effect extension modules read the vendor bag as they
// load. Nothing here mounts a lens — the socket is injected — but the import
// still has to resolve.
import './helpers/seed-vendor.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AskPanel } from '../src/static/shell/ask-panel.js'
import { ComposerMount } from '../src/static/shell/composer-mount.js'
import { InMemoryContainerProvider } from '../src/static/container/in-memory-container-provider.js'
import { QuestionList } from '../src/static/renderers/question-list.js'
// GLOW DROPPED (P4.B) regression guard: ask-panel.js does NOT import these — the
// mock exists purely as a trip-wire so a future re-coupling would be caught here.
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({
  setAiTargetGlow: vi.fn(), clearAiTargetGlow: vi.fn(), AiTargetDecoration: {},
}))
import { setAiTargetGlow } from '../src/static/lens/document-editor/surfaces/ai-target-decoration.js'

// Builds the structural #ask-panel exactly as index.html renders it (the child
// wires this, never rebuilds it). The panel has no header — the box floats,
// carrying its own drag handle as its first child. The composer's fixture is a
// bare div: what mounts into it is the lens's business, not the panel's.
function mountPanelDom({ open = false } = {}) {
  document.body.innerHTML = `
    <div id="ask-panel" class="ask-panel ${open ? 'is-open' : ''}">
      <div class="ask-composer">
        <div class="ask-handle"></div>
        <div class="ask-popup__input"></div>
        <div class="ask-popup__footer">
          <button class="ask-popup__send">Send</button>
        </div>
      </div>
    </div>`
  return document.getElementById('ask-panel')
}

/**
 * A stand-in for the draft socket: the ComposerMount verbs the panel uses, over
 * a plain string for the authored text and a REAL draft container for what the
 * message has attached — an attachment is a block of the draft, so a double
 * that kept it in a list would not be one. `harvest()` mirrors the real walk
 * closely enough for the panel's decisions — one prose element per
 * blank-line-separated block, then the container's own elements — and a test
 * needing a draft with structure in it pins the body with `compose`.
 */
function fakeComposer() {
  let value = ''
  let focused = false
  let provider = new InMemoryContainerProvider()
  /** @type {any[]|null} */ let elements = null
  /** @type {Array<() => void>} */ const submits = []
  /** @type {Array<() => void>} */ const changes = []
  /** @type {Array<(c: any) => void>} */ const mentions = []
  /** @type {Array<(title: string) => void>} */ const detaches = []
  /** @type {Array<() => void>} */ const clears = []
  /** What this stand-in publishes about itself. A test that wants a narrower
   *  draft rewrites it before the panel opens — the hint row is derived from it,
   *  never from a list the panel keeps. */
  const caps = { markdown: true, mentions: true, commands: true, blocks: false }
  return {
    opened: 0,
    resets: 0,
    /** @type {string[]} the titles the panel last told the draft to mark */
    marked: [],
    caps,
    open() { this.opened++ },
    capabilities() { return this.opened ? this.caps : null },
    setMentionTitles(titles) { this.marked = Array.from(titles || []) },
    focus() { focused = true },
    hasFocus: () => focused,
    blur() { focused = false },
    read: () => value,
    cut(start, end) { value = value.slice(0, start) + value.slice(end); changes.forEach((f) => f()) },
    get provider() { return provider },
    harvest() {
      const body = elements || value.split('\n\n').map((t) => t.trim()).filter(Boolean)
        .map((content, i) => ({ kind: 'prose', attrs: { id: 'b' + i, content } }))
      // The container holds the attachments and nothing else here, so the REAL
      // walk over it is exactly the attachment half of the harvest.
      return body.concat(ComposerMount.elementsOf(provider))
    },
    // A draft is a LIFETIME: retiring one hands back a different container, which
    // is what makes the attachments die with the message.
    reset() { this.resets++; value = ''; elements = null; provider = new InMemoryContainerProvider() },
    onSubmit(fn) { submits.push(fn); return () => {} },
    onChanged(fn) { changes.push(fn); return () => {} },
    onMention(fn) { mentions.push(fn); return () => {} },
    onDetachRequest(fn) { detaches.push(fn); return () => {} },
    onClearRequest(fn) { clears.push(fn); return () => {} },

    // ── What the harness drives ──────────────────────────────────────────────
    /** Writes the whole message and fires the change stream, as an edit does. */
    type(next) { value = next; changes.forEach((f) => f()) },
    /** Pins an exact harvest, for a draft with structure in it. */
    compose(list) {
      elements = list
      value = list.map((e) => e.attrs.content || e.attrs.source || '').join('\n\n')
    },
    /** The Mod+Enter the lens claimed. */
    submit() { submits.forEach((f) => f()) },
    /** The draft's menu asking for the document named by a token to be detached. */
    askDetach(title) { detaches.forEach((f) => f(title)) },
    /** The draft's menu asking for the whole message to be retired. */
    askClear() { clears.forEach((f) => f()) },
    /** A `@` candidate accepted in the draft: the echo lands in the text and the
     *  candidate reaches the panel's manifest, exactly as the surface does it. */
    mention(candidate, message) {
      value = message == null ? '@' + candidate.title : message
      mentions.forEach((f) => f(candidate))
      changes.forEach((f) => f())
    },
  }
}

/** One prose element, as the composer harvests a one-line message. */
const prose = (content, id = 'b0') => ({ kind: 'prose', attrs: { id, content } })

// A fake editor exposing exactly the surface the AskPanel touches. P4.E: the
// panel reaches TipTap ONLY through editor methods now — the fake deliberately
// has NO `tiptap` handle, so any reach would read undefined and fail loudly.
function fakeEditor(target = { kind: 'block', ref: 'co-9', label: 'Code Block' }, mode = 'wysiwyg') {
  const context = { target, caret: 1, range: { from: 1, to: 4 } }
  return {
    mode,
    askAi: vi.fn(() => Promise.resolve()),
    getSelectionContext: vi.fn(() => context),
    _context: context,
  }
}

// A fake workspace with a live selection stream + active editor + focus round-trip.
function fakeWorkspace(editor) {
  const subs = []
  return {
    _editor: editor,
    /** The mount the active tab holds — the host end of the container facade. */
    _mount: null,
    get activeTab() {
      return this._editor ? { editor: this._editor, mount: this._mount } : null
    },
    onSelectionUpdate: (fn) => { subs.push(fn); return () => {} },
    emit: (ctx) => subs.forEach((fn) => fn(ctx)),
    getSelectionContext: vi.fn(() => (editor ? editor.getSelectionContext() : null)),
    setPosition: vi.fn(),
  }
}

/** The panel over a driveable draft. Every test builds it this way, so the
 *  socket is always the thing being typed into. */
function build(ws, { commands, badges, mentions } = {}) {
  const composer = fakeComposer()
  const panel = new AskPanel(ws, commands, badges, mentions, /** @type {any} */ (composer))
  return { panel, composer }
}

const send = () => /** @type {HTMLElement} */ (document.querySelector('.ask-popup__send')).click()
const escape = () => document.getElementById('ask-panel').dispatchEvent(
  new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

beforeEach(() => {
  vi.mocked(setAiTargetGlow).mockClear()
  window.initAskPanelPinned = false
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('AskPanel — DOM wiring + open/close/toggle', () => {
  it('null-guards a missing #ask-panel (constructor no-ops, verbs safe)', () => {
    document.body.innerHTML = ''
    const { panel } = build(fakeWorkspace(fakeEditor()))
    expect(() => { panel.open(); panel.close(); panel.toggle() }).not.toThrow()
  })

  it('open() sets .is-open, seeds the target chip, brings up the draft and focuses it', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const ws = fakeWorkspace(fakeEditor({ kind: 'block', ref: 'co-9', label: 'Code Block' }))
    const { panel, composer } = build(ws)
    panel.open()
    expect(el.classList.contains('is-open')).toBe(true)
    expect(composer.opened).toBe(1)
    vi.runAllTimers()
    expect(el.querySelector('.ask-target-chip__label').textContent).toBe('Code Block')
    expect(composer.hasFocus()).toBe(true)
  })

  it('re-opening returns to the draft being written — close KEEPS it', () => {
    vi.useFakeTimers()
    mountPanelDom()
    const { panel, composer } = build(fakeWorkspace(fakeEditor()))
    panel.open()
    vi.runAllTimers()
    composer.type('half a question')
    panel.close()
    composer.blur()
    panel.open()
    expect(composer.read()).toBe('half a question')
    expect(composer.resets).toBe(0)
  })

  it('close() removes .is-open when unpinned and restores the focus coordinate', () => {
    const el = mountPanelDom({ open: true })
    const ws = fakeWorkspace(fakeEditor())
    const { panel } = build(ws)
    panel.open()             // pulls #focusReturn = ws.getSelectionContext()
    panel.close()
    expect(el.classList.contains('is-open')).toBe(false)
    expect(ws.setPosition).toHaveBeenCalled()
  })

  it('close() keeps .is-open when pinned', () => {
    window.initAskPanelPinned = true
    const el = mountPanelDom({ open: true })
    const { panel } = build(fakeWorkspace(fakeEditor()))
    panel.close()
    expect(el.classList.contains('is-open')).toBe(true)
  })

  it('Escape while pinned untoggles through the persisted endpoint (no ✕ — the panel has no header)', () => {
    window.initAskPanelPinned = true
    const ajax = vi.fn(() => Promise.resolve())
    window.htmx = { ajax }
    try {
      mountPanelDom({ open: true })
      build(fakeWorkspace(fakeEditor()))
      escape()
      expect(ajax).toHaveBeenCalledWith('POST', '/api/session/toggle/askpanel', { swap: 'none' })
    } finally {
      window.htmx = undefined
    }
  })

  it('a Ctrl+Shift+A jump-out (close) while pinned does NOT touch the persisted endpoint', () => {
    window.initAskPanelPinned = true
    const ajax = vi.fn(() => Promise.resolve())
    window.htmx = { ajax }
    try {
      mountPanelDom({ open: true })
      const { panel } = build(fakeWorkspace(fakeEditor()))
      panel.close()                        // jump-out, not dismiss
      expect(ajax).not.toHaveBeenCalled()  // pin state untouched
    } finally {
      window.htmx = undefined
    }
  })

  it('toggle() opens when closed', () => {
    const el = mountPanelDom()
    const { panel } = build(fakeWorkspace(fakeEditor()))
    panel.toggle()
    expect(el.classList.contains('is-open')).toBe(true)
  })

  it('toggle() closes when the DRAFT has focus — the jump-out is focus-resolved', () => {
    mountPanelDom({ open: true })
    const ws = fakeWorkspace(fakeEditor())
    const { panel, composer } = build(ws)
    composer.focus()
    panel.toggle()
    expect(ws.setPosition).toHaveBeenCalled()   // returned to editor
  })
})

describe('AskPanel — F1 send targets the ACTIVE editor with the harvested question', () => {
  it('send calls activeTab.editor.askAi with the DRAFT AS A LIST and retires the draft', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.type('why is the sky blue?')
    send()
    expect(editor.askAi).toHaveBeenCalledWith({
      type: 'ask',
      question: [prose('why is the sky blue?')],
      context: editor._context,
    })
    expect(composer.resets).toBe(1)   // a sent message leaves no draft behind
  })

  it('A DRAFT IS A LIST: every block written travels, in order', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    const written = [
      prose('why does this fail?', 'b0'),
      { kind: 'code', attrs: { id: 'b1', source: 'panic()', language: 'go' } },
      prose('and what should it do?', 'b2'),
    ]
    composer.compose(written)
    send()
    expect(editor.askAi.mock.calls[0][0].question).toEqual(written)
  })

  it('send is a no-op for an empty/whitespace question', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.type('   ')
    send()
    expect(editor.askAi).not.toHaveBeenCalled()
  })

  it('send targets whatever editor is active AT SEND (re-pointed via activeTab)', () => {
    mountPanelDom({ open: true })
    const first = fakeEditor()
    const ws = fakeWorkspace(first)
    const { composer } = build(ws)
    const second = fakeEditor()
    ws._editor = second
    composer.type('q')
    send()
    expect(first.askAi).not.toHaveBeenCalled()
    expect(second.askAi).toHaveBeenCalledWith({
      type: 'ask', question: [prose('q')], context: second._context,
    })
  })

  it('send is DUMB UI: it hands over the question + context and touches no tiptap/position seam', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'selection', ref: 'pr-1', label: 'Paragraph' }, 'wysiwyg')
    const { composer } = build(fakeWorkspace(editor))
    composer.type('q')
    send()
    // The editor owns EVERYTHING doc-facing inside askAi — the panel only hands over
    // the question + the context it rendered. No target-prep, no applyPosition.
    expect(editor.askAi).toHaveBeenCalledTimes(1)
    expect(editor.askAi.mock.calls[0][0].context).toBe(editor._context)
  })

  it('a markdown-mode send still asks (the editor owns any markdown handling in askAi)', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'document', ref: '', label: 'Document' }, 'markdown')
    const { composer } = build(fakeWorkspace(editor))
    composer.type('q')
    send()
    expect(editor.askAi).toHaveBeenCalledWith({
      type: 'ask', question: [prose('q')], context: editor._context,
    })
  })

  it('D-5 anti-race: send acts on the context the panel CAPTURED on open, not a re-read at send', () => {
    mountPanelDom()   // closed
    const editor = fakeEditor({ kind: 'block', ref: 'r1', label: 'A' })
    const ws = fakeWorkspace(editor)
    const { panel, composer } = build(ws)
    panel.open()                 // captures the CURRENT context (r1) as #lastContext
    editor._context = { target: { kind: 'block', ref: 'r2', label: 'B' }, caret: 9, range: null }
    editor.getSelectionContext = vi.fn(() => editor._context)
    composer.type('q')
    send()
    expect(editor.askAi.mock.calls[0][0].context.target.ref).toBe('r1')
  })

  it("the composer's SUBMIT gesture sends; Escape on the panel closes", () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const ws = fakeWorkspace(editor)
    const { composer } = build(ws)
    composer.type('q')
    composer.submit()
    expect(editor.askAi).toHaveBeenCalled()
    escape()
    expect(ws.setPosition).toHaveBeenCalled()
  })
})

// The invariant: whenever the panel is VISIBLE, the draft is MOUNTED. A pinned
// panel becomes visible without open() ever running (boot with ShowAskPanel, or
// the View-menu pin toggle) — the draft socket must not be left empty on either
// path, and neither path is a jump-in, so neither may steal focus.
describe('AskPanel — the draft is mounted whenever the panel is visible (fix round 1)', () => {
  it('constructing over a panel already carrying is-open mounts the composer', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    expect(composer.opened).toBe(1)
  })

  it('the sieve:ask-panel-toggled event pinning ON mounts the composer', () => {
    mountPanelDom()   // closed
    const { composer } = build(fakeWorkspace(fakeEditor()))
    expect(composer.opened).toBe(0)
    document.dispatchEvent(new window.CustomEvent('sieve:ask-panel-toggled', { detail: true }))
    expect(composer.opened).toBe(1)
  })

  it('neither boot-mount nor pin-mount focuses the composer — that stays open()\'s job', () => {
    mountPanelDom({ open: true })
    const { composer: bootComposer } = build(fakeWorkspace(fakeEditor()))
    expect(bootComposer.hasFocus()).toBe(false)

    mountPanelDom()   // closed
    const { composer: pinComposer } = build(fakeWorkspace(fakeEditor()))
    document.dispatchEvent(new window.CustomEvent('sieve:ask-panel-toggled', { detail: true }))
    expect(pinComposer.hasFocus()).toBe(false)
  })
})

// The footer's hint row is DERIVED, and these hold the panel to deriving it: it
// draws only once a lens exists to publish a spec, and it draws that lens's
// spec — never a list the panel keeps of what it thinks a composer does.
describe('AskPanel — the footer states what the draft answers to (#118 item 4)', () => {
  const hints = () => Array.from(document.querySelectorAll('.ask-popup__hint'))
    .map((h) => h.textContent)
  /** The mod key label `ComposerHints` resolves for the current test platform. */
  const MOD = navigator.platform && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'

  it('says nothing until a draft is mounted', () => {
    mountPanelDom()   // closed: no lens, so no spec
    build(fakeWorkspace(fakeEditor()))
    expect(hints()).toEqual([])
  })

  it('states the composer\'s claim plus what its LENS publishes, on open', () => {
    mountPanelDom()
    const { panel } = build(fakeWorkspace(fakeEditor()))
    panel.open()
    expect(hints()).toEqual([`${MOD}+Enter send`, '@ mention', '/ command'])
  })

  it('a draft built WITHOUT a mention service does not advertise `@`', () => {
    mountPanelDom()
    const { panel, composer } = build(fakeWorkspace(fakeEditor()))
    composer.caps = { markdown: true, mentions: false, commands: true, blocks: false }
    panel.open()
    expect(hints()).toEqual([`${MOD}+Enter send`, '/ command'])
  })

  it('a draft built WITHOUT a command service does not advertise `/`', () => {
    mountPanelDom()
    const { panel, composer } = build(fakeWorkspace(fakeEditor()))
    composer.caps = { markdown: true, mentions: true, commands: false, blocks: false }
    panel.open()
    expect(hints()).toEqual([`${MOD}+Enter send`, '@ mention'])
  })

  it('a PINNED panel, visible without an open(), states them too', () => {
    mountPanelDom({ open: true })
    build(fakeWorkspace(fakeEditor()))
    expect(hints()).toEqual([`${MOD}+Enter send`, '@ mention', '/ command'])
  })
})

// The `@Title` mark and the chip are two views of ONE manifest, so the panel —
// which holds it — is what tells the draft which titles to mark.
describe('AskPanel — the draft marks the @Titles it has attached (#118 item 5)', () => {
  const AUTH = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' }
  const RETRY = { uri: 'container:1a2b', title: 'Retry RFC', kind: 'note' }

  it('an accepted candidate reaches the draft as a title to mark', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, 'How does @Auth Design handle this?')
    expect(composer.marked).toEqual(['Auth Design'])
  })

  it('DELETING THE TOKEN UNMARKS IT: the marks follow the chips, edit by edit', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, 'about @Auth Design')
    composer.type('about nothing in particular')
    expect(composer.marked).toEqual([])
  })

  it('two attachments mark two titles, and dropping one leaves the other', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, '@Auth Design')
    composer.mention(RETRY, '@Auth Design and @Retry RFC')
    expect(composer.marked).toEqual(['Auth Design', 'Retry RFC'])
    composer.type('@Retry RFC alone')
    expect(composer.marked).toEqual(['Retry RFC'])
  })
})

describe('AskPanel — transitional sieve:ai-* consumers (moved OUT of editor.js)', () => {
  it('sieve:ai-ask opens the panel', () => {
    const el = mountPanelDom()
    build(fakeWorkspace(fakeEditor()))
    document.dispatchEvent(new window.CustomEvent('sieve:ai-ask'))
    expect(el.classList.contains('is-open')).toBe(true)
  })

  it('sieve:ai-explain asks with type explain + the current context (no target-prep step)', () => {
    mountPanelDom()
    const editor = fakeEditor({ kind: 'selection', ref: 'pr-1', label: 'Paragraph' }, 'wysiwyg')
    build(fakeWorkspace(editor))
    document.dispatchEvent(new window.CustomEvent('sieve:ai-explain'))
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'explain', context: editor._context })
  })

  it('sieve:ai-explain STILL calls askAi in markdown — the editor owns the abort, not the panel', () => {
    mountPanelDom()
    const editor = fakeEditor({ kind: 'document', ref: '', label: 'Document' }, 'markdown')
    build(fakeWorkspace(editor))
    document.dispatchEvent(new window.CustomEvent('sieve:ai-explain'))
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'explain', context: editor._context })
  })
})

describe('AskPanel — GLOW DROPPED (P4.B)', () => {
  it('a selection-update while the draft is focused does NOT paint a glow', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const ws = fakeWorkspace(editor)
    const { composer } = build(ws)
    composer.focus()
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph', range: { from: 1, to: 4 } } })
    expect(setAiTargetGlow).not.toHaveBeenCalled()
  })
})

describe('AskPanel — @ attachments (#74 P4, re-sourced onto the draft in #118)', () => {
  const AUTH = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' }
  const chips = () => Array.from(document.querySelectorAll('.ask-chip'))
  /** The question the panel sent, and the reference elements in it — an
   *  attachment travels as a BLOCK OF THE MESSAGE, so that is where it is read. */
  const question = (editor) => editor.askAi.mock.calls[0][0].question
  const sent = (editor) => question(editor).filter((el) => el.kind === 'reference')

  it('a candidate accepted in the draft adds a chip carrying its address', () => {
    const el = mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, 'How does @Auth Design handle this?')
    expect(chips().length).toBe(1)
    expect(chips()[0].getAttribute('data-uri')).toBe('container:9f2b')
    expect(el.querySelector('.ask-chip__label').textContent).toBe('Auth Design')
  })

  it('send carries the attachment as an ELEMENT OF THE QUESTION and then clears the chips', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.mention(AUTH, 'How does @Auth Design handle retries?')
    send()
    // ONE list, and no second copy riding beside it: the panel passes no
    // attachments of its own, because the message already contains them.
    expect(editor.askAi).toHaveBeenCalledWith({
      type: 'ask',
      question: [
        prose('How does @Auth Design handle retries?'),
        QuestionList.attachment('container:9f2b', 'Auth Design'),
      ],
      context: editor._context,
    })
    expect(chips().length).toBe(0)
  })

  it('SEND-TIME SETTLEMENT: an attachment whose @Title was deleted leaves the draft', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.mention(AUTH, '@Auth Design')
    expect(chips().length).toBe(1)

    composer.type('never mind, generic question')
    send()
    expect(sent(editor)).toEqual([])
  })

  it('the ✕ on a chip detaches it — and takes the @Title token out of the draft', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.mention(AUTH, 'ask @Auth Design about it')
    const remove = /** @type {HTMLElement} */ (document.querySelector('.ask-chip__remove'))
    remove.click()
    expect(chips().length).toBe(0)
    expect(composer.read()).toBe('ask about it')

    send()
    expect(sent(editor)).toEqual([])
  })

  // The draft's own menu reaches the element through the same door the chip's ✕
  // does: a token and its element are ONE object, so removing either removes both.
  it('the draft asking to detach a title does exactly what the ✕ does', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.mention(AUTH, 'ask @Auth Design about it')
    composer.askDetach('Auth Design')
    expect(chips().length).toBe(0)
    expect(composer.read()).toBe('ask about it')

    send()
    expect(sent(editor)).toEqual([])
  })

  it('a title nothing is attached under is a no-op, chips and message untouched', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, 'ask @Auth Design about it')
    composer.askDetach('Retry RFC')
    expect(chips().length).toBe(1)
    expect(composer.read()).toBe('ask @Auth Design about it')
  })

  it('LIVE RECONCILE: breaking the token drops the chip immediately, not at send', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, 'How does @Auth Design work?')
    expect(chips().length).toBe(1)

    // One character out of the title — the state the old code claimed was still
    // attached right up until send silently dropped it.
    composer.type('How does @Auth Desig work?')
    expect(chips().length).toBe(0)
  })

  it('UNDO re-attaches: the token coming back brings its chip and its element', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.mention(AUTH, 'How does @Auth Design work?')
    composer.type('How does work?')
    expect(chips().length).toBe(0)

    composer.type('How does @Auth Design work?')
    expect(chips().length).toBe(1)
    send()
    expect(sent(editor)).toEqual([QuestionList.attachment('container:9f2b', 'Auth Design')])
  })

  it('a slash command carries the SAME manifest shape (attachments are not Ask-only)', () => {
    mountPanelDom({ open: true })
    const commands = {
      list: () => [{ name: 'btw', description: 'by the way' }],
      resolve: vi.fn(() => ({ cmd: { name: 'btw' }, args: 'about @Auth Design' })),
      dispatch: vi.fn(() => ({ correlationId: 'c-x', onResult: vi.fn(), cancel: vi.fn() })),
    }
    const { composer } = build(fakeWorkspace(fakeEditor()), { commands })
    composer.mention(AUTH, '/btw about @Auth Design')
    send()
    expect(commands.dispatch).toHaveBeenCalledWith(
      'btw', 'about @Auth Design', expect.anything(), undefined,
      [{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it('with no MentionService the panel still works — nothing ever attaches', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const { composer } = build(fakeWorkspace(editor))
    composer.type('plain @question')
    send()
    expect(sent(editor)).toEqual([])
  })
})

// A draft is a LIFETIME, and clearing it retires the whole arrangement rather
// than blanking a value — which is also why it is undo-less and says so. It is
// not a dismissal: the panel stays where it is and the caret goes back into the
// fresh message.
describe('AskPanel — clearing the draft (#118 3c)', () => {
  const AUTH = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' }

  it('retires the draft and takes its attachments with it', () => {
    mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.mention(AUTH, 'ask @Auth Design about it')
    expect(document.querySelectorAll('.ask-chip').length).toBe(1)

    composer.askClear()
    expect(composer.resets).toBe(1)
    expect(composer.read()).toBe('')
    expect(document.querySelectorAll('.ask-chip').length).toBe(0)
  })

  it('leaves the panel open and puts the caret back in the message', () => {
    const el = mountPanelDom({ open: true })
    const { composer } = build(fakeWorkspace(fakeEditor()))
    composer.type('half a question')
    composer.blur()

    composer.askClear()
    expect(el.classList.contains('is-open')).toBe(true)
    expect(composer.hasFocus()).toBe(true)
  })
})

// ── The target renders as chips in the footer (#74) ───────────────────────────
//
// A target chip is NOT an attachment: the editor owns the selection and the
// panel merely draws it, so it carries no ✕ (the cross keeps exactly one
// meaning — drop an attachment) and it never reaches the manifest.
describe('AskPanel — the footer shows what the message will act on', () => {
  const targetChips = () => document.querySelectorAll('.ask-target-chip')

  it('renders ONE view-only chip for the target, with no remove affordance', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const { panel } = build(fakeWorkspace(fakeEditor({ kind: 'block', ref: 'co-1', label: 'Code Block' })))
    panel.open()
    vi.runAllTimers()

    const chips = targetChips()
    expect(chips.length).toBe(1)
    expect(chips[0].querySelector('.ask-target-chip__label').textContent).toBe('Code Block')
    expect(chips[0].querySelector('button')).toBe(null)          // no ✕: the editor owns the selection
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)      // and it is not an attachment chip
  })

  it('tracks the selection stream', () => {
    vi.useFakeTimers()
    mountPanelDom()
    const editor = fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })
    const ws = fakeWorkspace(editor)
    const { panel } = build(ws)
    panel.open()
    vi.runAllTimers()
    expect(targetChips()[0].textContent).toContain('Document')

    editor.getSelectionContext = () => ({ target: { kind: 'selection', ref: 'pr-1', label: '“retry policy”' } })
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: '“retry policy”' } })
    vi.runAllTimers()
    expect(targetChips()[0].textContent).toContain('“retry policy”')
  })

  it('does NOT repaint the target chip while the panel is closed', () => {
    vi.useFakeTimers()
    const editor = fakeEditor({ kind: 'block', ref: 'co-1', label: 'Code Block' })
    const ws = fakeWorkspace(editor)
    mountPanelDom({ open: true })
    const { panel } = build(ws)
    panel.open()
    vi.runAllTimers()
    expect(targetChips()[0].textContent).toContain('Code Block')

    panel.close()
    editor.getSelectionContext = () => ({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    vi.runAllTimers()
    expect(targetChips()[0].textContent).toContain('Code Block')   // untouched
  })

  it('is NOT an attachment: it never becomes one, and a send leaves it standing', () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })
    const { panel, composer } = build(fakeWorkspace(editor))
    panel.open()
    vi.runAllTimers()
    composer.mention({ uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' },
      'How does @Auth Design work?')

    // One of each in the footer, told apart by class — and only one is removable.
    expect(targetChips().length).toBe(1)
    expect(el.querySelectorAll('.ask-chip').length).toBe(1)
    expect(el.querySelectorAll('.ask-chip__remove').length).toBe(1)

    send()
    expect(editor.askAi.mock.calls[0][0].question
      .filter((/** @type {any} */ el) => el.kind === 'reference'))
      .toEqual([QuestionList.attachment('container:9f2b', 'Auth Design')])
    // The attachment chip clears with the message; the target belongs to the
    // editor, so it is still there.
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)
    expect(targetChips().length).toBe(1)
  })

  it('renders nothing before the panel has a context', () => {
    mountPanelDom()
    build(fakeWorkspace(null))
    expect(targetChips().length).toBe(0)
  })

  it('THE FOOTER IS HINTS + CHIPS + SEND, in reading order and on ONE row (#118)', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const { panel } = build(fakeWorkspace(fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })))
    panel.open()
    vi.runAllTimers()

    const footer = el.querySelector('.ask-popup__footer')
    expect(Array.from(footer.children).map((c) => c.className.split(' ')[0]))
      .toEqual(['ask-popup__hints', 'ask-popup__target', 'ask-popup__chips', 'ask-popup__send'])
    expect(targetChips().length).toBe(1)
  })

  it('a SELECTION gets a chip per block, labelled from the ACTIVE CONTAINER (#82)', () => {
    vi.useFakeTimers()
    mountPanelDom()
    const ws = fakeWorkspace(fakeEditor({ kind: 'selection', ref: 'b1,b2', label: '“retry policy”' }))
    ws._editor.getSelectionContext = () => ({
      docUuid: 'u-1',
      target: { kind: 'selection', ref: 'b1,b2', label: '“retry policy”' },
      blockIds: ['b1', 'b2'],
    })
    const held = {
      b1: { id: 'b1', kind: 'prose', attrs: {} },
      b2: { id: 'b2', kind: 'code', attrs: { language: 'go' } },
    }
    ws._mount = { provider: { getBlock: (id) => held[id] || null, subscribe() {}, unsubscribe() {} } }
    const { panel } = build(ws)
    panel.open()
    vi.runAllTimers()

    const labels = Array.from(targetChips())
      .map((c) => c.querySelector('.ask-target-chip__label').textContent)
    expect(labels).toEqual(['“retry policy”', 'prose', 'go'])
  })

  it('repaints a chip when the block behind it changes under a still selection (#82)', () => {
    vi.useFakeTimers()
    const ws = fakeWorkspace(fakeEditor({ kind: 'selection', ref: 'b2', label: '“retry policy”' }))
    ws._editor.getSelectionContext = () => ({
      docUuid: 'u-1',
      target: { kind: 'selection', ref: 'b2', label: '“retry policy”' },
      blockIds: ['b2'],
    })
    let language = 'go'
    /** @type {any[]} */ const listeners = []
    ws._mount = {
      provider: {
        getBlock: (id) => ({ id, kind: 'code', attrs: { language } }),
        subscribe: (l) => listeners.push(l),
        unsubscribe: () => {},
      },
    }
    mountPanelDom()
    const { panel } = build(ws)
    panel.open()
    vi.runAllTimers()
    const language1 = () => targetChips()[1].querySelector('.ask-target-chip__label').textContent
    expect(language1()).toBe('go')

    // The caret has not moved — only the block's own truth changed. The panel is
    // a SECOND follower of the same container, so it hears the cue directly.
    language = 'rust'
    listeners.forEach((l) => l.onChanged({ blockIds: ['b2'], orderChanged: false }))
    expect(language1()).toBe('rust')
  })
})

describe('AskPanel — Slash command routing (#55)', () => {
  it('dispatches a valid slash command via commandService and retires the draft', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const commands = {
      // list() is part of the CommandService contract the `/` provider consumes.
      list: () => [{ name: 'btw', description: 'Ask btw' }],
      resolve: vi.fn((input) => input.startsWith('/btw')
        ? { cmd: { name: 'btw', description: 'Ask btw' }, args: 'what is X' } : null),
      // Returns a dispatch handle; the badge (not the panel) wires onResult.
      dispatch: vi.fn(() => ({ correlationId: 'c-x', onResult: vi.fn(), cancel: vi.fn() })),
    }
    const { composer } = build(fakeWorkspace(editor), { commands })
    composer.type('/btw what is X')
    send()

    expect(commands.resolve).toHaveBeenCalledWith('/btw what is X')
    // Dispatched with NO onResult callback — the dead editor.handleCommandResult
    // seam was removed; the badge owns the result lifecycle via handle.onResult.
    expect(commands.dispatch).toHaveBeenCalledWith('btw', 'what is X', expect.anything(), undefined, [])
    expect(editor.askAi).not.toHaveBeenCalled()
    expect(composer.resets).toBe(1)
  })

  it('a command send while pinned keeps the panel open (no dismiss-on-send)', () => {
    window.initAskPanelPinned = true
    const el = mountPanelDom({ open: true })
    const commands = {
      list: () => [{ name: 'btw', description: 'Ask btw' }],
      resolve: vi.fn(() => ({ cmd: { name: 'btw', description: 'Ask btw' }, args: 'x' })),
      dispatch: vi.fn(() => ({ correlationId: 'c-x', onResult: vi.fn(), cancel: vi.fn() })),
    }
    const { composer } = build(fakeWorkspace(fakeEditor()), { commands })
    composer.type('/btw x')
    send()

    expect(commands.dispatch).toHaveBeenCalled()
    expect(composer.resets).toBe(1)
    expect(el.classList.contains('is-open')).toBe(true)   // pinned → send never unpins
  })

  // THE DISPATCH RULE. A command is one line: it has one text argument and
  // nowhere to put a second block, so a draft with structure in it is an ASK
  // however it opens.
  it('a MULTI-BLOCK draft that opens with a slash is an ask, not a command', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const commands = {
      list: () => [{ name: 'btw', description: 'Ask btw' }],
      resolve: vi.fn(() => ({ cmd: { name: 'btw' }, args: 'x' })),
      dispatch: vi.fn(),
    }
    const { composer } = build(fakeWorkspace(editor), { commands })
    composer.compose([
      prose('/btw what is this', 'b0'),
      { kind: 'code', attrs: { id: 'b1', source: 'x := 1', language: 'go' } },
    ])
    send()

    expect(commands.dispatch).not.toHaveBeenCalled()
    expect(editor.askAi).toHaveBeenCalledTimes(1)
  })

  it('a draft whose ONE block is a code fence is an ask, whatever it contains', () => {
    mountPanelDom({ open: true })
    const editor = fakeEditor()
    const commands = {
      list: () => [], resolve: vi.fn(() => ({ cmd: { name: 'btw' }, args: '' })), dispatch: vi.fn(),
    }
    const { composer } = build(fakeWorkspace(editor), { commands })
    composer.compose([{ kind: 'code', attrs: { id: 'b0', source: '/etc/hosts', language: '' } }])
    send()

    expect(commands.dispatch).not.toHaveBeenCalled()
    expect(editor.askAi).toHaveBeenCalledTimes(1)
  })
})
