// ask-panel.test.js — P4.B. The Ask panel is now a PERMANENT Workspace child
// (shell/ask-panel.js), constructed once, wiring the STRUCTURAL #ask-panel DOM
// (index.html) — never rebuilding it. It owns the label debounce, the focus
// round-trip (ws.getSelectionContext/setPosition), the pinned flag, the glow
// LIFETIME (textarea focus/blur), and the ws.onSelectionUpdate subscription (the
// P3.D boot closure, now OWNED here). On SEND it targets ws.activeTab.editor and
// calls the ONE editor seam (editor.askAi) — never a workspace proxy.
//
// F1–F5 (the P3.D stateless-panel behaviours) are pinned here as they move into
// the child: F1 send pulls the LIVE getSelectionContext at send; F2 label
// re-renders on selection change; F5-adjacent read-only targeting rides the live
// pull. The Ask-panel FOCUS GLOW is DROPPED in P4.B (maintainer decision) — no
// setAiTargetGlow/clearAiTargetGlow on textarea focus/blur, no glow==send test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AskPanel } from '../src/static/shell/ask-panel.js'
import { CommandService } from '../src/static/block/command-service.js'
import { WorkspaceService } from '../src/static/block/workspace-service.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'
// GLOW DROPPED (P4.B) regression guard: ask-panel.js does NOT import these — the
// mock exists purely as a trip-wire so a future re-coupling would be caught here.
vi.mock('../src/static/ai/ai-target-decoration.js', () => ({
  setAiTargetGlow: vi.fn(), clearAiTargetGlow: vi.fn(), AiTargetDecoration: {},
}))
import { setAiTargetGlow } from '../src/static/ai/ai-target-decoration.js'

// Builds the structural #ask-panel exactly as index.html renders it (the child
// wires this, never rebuilds it).
function mountPanelDom({ open = false } = {}) {
  document.body.innerHTML = `
    <div id="ask-panel" class="ask-panel ${open ? 'is-open' : ''}">
      <div class="ask-popup__header">
        <span class="ask-popup__label">Ask About Document</span>
        <button class="ask-popup__close" aria-label="Close" title="Close">&#10005;</button>
      </div>
      <textarea class="ask-popup__input" placeholder="Ask a question… Enter sends · Shift+Enter for a new line" spellcheck="false"></textarea>
      <div class="ask-popup__footer">
        <button class="ask-popup__send">Send</button>
      </div>
    </div>`
  return document.getElementById('ask-panel')
}

// A fake MentionService: the plane tenant the `@` provider talks to. The panel
// only ever hands it to the provider — it never speaks the wire itself (#49).
function fakeMentions(candidates) {
  return { search: vi.fn(() => Promise.resolve(candidates || [])) }
}

// A fake editor exposing exactly the surface the AskPanel touches. P4.E: the
// panel reaches TipTap ONLY through editor methods now — the fake deliberately
// has NO `tiptap` handle, so any reach would read undefined and fail loudly.
function fakeEditor(target = { kind: 'block', ref: 'co-9', label: 'Code Block' }, mode = 'wysiwyg') {
  // D-5: the panel reaches TipTap ONLY through editor.askAi — it holds no tiptap and
  // never calls a target-prep/applyPosition seam (the editor owns the highlight/insert/
  // cursor INSIDE askAi). The fake exposes exactly askAi + getSelectionContext, the
  // latter returning a STABLE context object so the send's context arg is assertable.
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
    get activeTab() { return this._editor ? { editor: this._editor } : null },
    onSelectionUpdate: (fn) => { subs.push(fn); return () => {} },
    emit: (ctx) => subs.forEach((fn) => fn(ctx)),
    getSelectionContext: vi.fn(() => (editor ? editor.getSelectionContext() : null)),
    setPosition: vi.fn(),
  }
}

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
    const panel = new AskPanel(fakeWorkspace(fakeEditor()))
    expect(() => { panel.open(); panel.close(); panel.toggle() }).not.toThrow()
  })

  it('open() sets .is-open, seeds the label, and focuses the textarea', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const ws = fakeWorkspace(fakeEditor({ kind: 'block', ref: 'co-9', label: 'Code Block' }))
    const panel = new AskPanel(ws)
    panel.open()
    expect(el.classList.contains('is-open')).toBe(true)
    vi.runAllTimers()
    expect(el.querySelector('.ask-popup__label').textContent).toBe('Ask About Code Block')
    expect(document.activeElement).toBe(el.querySelector('.ask-popup__input'))
  })

  it('close() removes .is-open when unpinned and restores the focus coordinate', () => {
    const el = mountPanelDom({ open: true })
    const ws = fakeWorkspace(fakeEditor())
    const panel = new AskPanel(ws)
    panel.open()             // pulls #focusReturn = ws.getSelectionContext()
    panel.close()
    expect(el.classList.contains('is-open')).toBe(false)
    expect(ws.setPosition).toHaveBeenCalled()
  })

  it('close() keeps .is-open when pinned', () => {
    window.initAskPanelPinned = true
    const el = mountPanelDom({ open: true })
    const panel = new AskPanel(fakeWorkspace(fakeEditor()))
    panel.close()
    expect(el.classList.contains('is-open')).toBe(true)
  })

  it('the ✕ button while pinned untoggles through the persisted endpoint', () => {
    window.initAskPanelPinned = true
    const ajax = vi.fn(() => Promise.resolve())
    window.htmx = { ajax }
    try {
      const el = mountPanelDom({ open: true })
      new AskPanel(fakeWorkspace(fakeEditor()))
      el.querySelector('.ask-popup__close').click()
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
      const panel = new AskPanel(fakeWorkspace(fakeEditor()))
      panel.close()                        // jump-out, not dismiss
      expect(ajax).not.toHaveBeenCalled()  // pin state untouched
    } finally {
      window.htmx = undefined
    }
  })

  it('toggle() opens when closed', () => {
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor()))
    panel.toggle()
    expect(el.classList.contains('is-open')).toBe(true)
  })

  it('toggle() closes when the box has focus', () => {
    const el = mountPanelDom({ open: true })
    const ws = fakeWorkspace(fakeEditor())
    const panel = new AskPanel(ws)
    el.querySelector('.ask-popup__input').focus()
    panel.toggle()
    expect(ws.setPosition).toHaveBeenCalled()   // returned to editor
  })
})

describe('AskPanel — F2 label re-renders on the selection stream', () => {
  it('updates the label when open, from ws.getSelectionContext().target.label', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const editor = fakeEditor({ kind: 'block', ref: 'co-1', label: 'Code Block' })
    const ws = fakeWorkspace(editor)
    const panel = new AskPanel(ws)
    panel.open()
    // Move selection to a paragraph; the stream fires.
    editor.getSelectionContext = () => ({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    vi.runAllTimers()
    expect(el.querySelector('.ask-popup__label').textContent).toBe('Ask About Paragraph')
  })

  it('a "Follow-up" label renders as "Ask Follow-up"', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const editor = fakeEditor({ kind: 'block', ref: 'ai-1', label: 'Follow-up' })
    const ws = fakeWorkspace(editor)
    const panel = new AskPanel(ws)
    panel.open()
    ws.emit({ target: { kind: 'block', ref: 'ai-1', label: 'Follow-up' } })
    vi.runAllTimers()
    expect(el.querySelector('.ask-popup__label').textContent).toBe('Ask Follow-up')
  })

  it('does NOT update the label when the panel is closed', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()   // closed
    const editor = fakeEditor({ kind: 'block', ref: 'co-1', label: 'Code Block' })
    const ws = fakeWorkspace(editor)
    new AskPanel(ws)
    editor.getSelectionContext = () => ({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    vi.runAllTimers()
    expect(el.querySelector('.ask-popup__label').textContent).toBe('Ask About Document') // untouched
  })
})

describe('AskPanel — F1 send targets the ACTIVE editor with the LIVE question', () => {
  it('send calls activeTab.editor.askAi({type:"ask", question}) and clears the box', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    const ws = fakeWorkspace(editor)
    new AskPanel(ws)
    const ta = el.querySelector('.ask-popup__input')
    ta.value = 'why is the sky blue?'
    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'ask', question: 'why is the sky blue?', context: editor._context, attachments: [] })
    expect(ta.value).toBe('')   // cleared after send
  })

  it('send is a no-op for an empty/whitespace question', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor))
    el.querySelector('.ask-popup__input').value = '   '
    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi).not.toHaveBeenCalled()
  })

  it('send targets whatever editor is active AT SEND (re-pointed via activeTab)', () => {
    const el = mountPanelDom({ open: true })
    const first = fakeEditor()
    const ws = fakeWorkspace(first)
    new AskPanel(ws)
    // The active editor changes (tab switch) before send.
    const second = fakeEditor()
    ws._editor = second
    el.querySelector('.ask-popup__input').value = 'q'
    el.querySelector('.ask-popup__send').click()
    expect(first.askAi).not.toHaveBeenCalled()
    expect(second.askAi).toHaveBeenCalledWith({ type: 'ask', question: 'q', context: second._context, attachments: [] })
  })

  it('send is DUMB UI: it passes the question + context to askAi and touches no tiptap/position seam', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'selection', ref: 'pr-1', label: 'Paragraph' }, 'wysiwyg')
    new AskPanel(fakeWorkspace(editor))
    el.querySelector('.ask-popup__input').value = 'q'
    el.querySelector('.ask-popup__send').click()
    // The editor owns EVERYTHING doc-facing inside askAi — the panel only hands over
    // the question + the context it rendered. No target-prep, no applyPosition.
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'ask', question: 'q', context: editor._context, attachments: [] })
    expect(editor.askAi).toHaveBeenCalledTimes(1)
  })

  it('a markdown-mode send still asks (the editor owns any markdown handling in askAi)', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'document', ref: '', label: 'Document' }, 'markdown')
    new AskPanel(fakeWorkspace(editor))
    el.querySelector('.ask-popup__input').value = 'q'
    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'ask', question: 'q', context: editor._context, attachments: [] })
  })

  it('D-5 anti-race: send acts on the context the panel CAPTURED (open/label), not a re-read at send', () => {
    const el = mountPanelDom()   // closed
    const editor = fakeEditor({ kind: 'block', ref: 'r1', label: 'A' })
    const ws = fakeWorkspace(editor)
    const panel = new AskPanel(ws)
    panel.open()                 // captures the CURRENT context (r1) as #lastContext
    // The selection now DRIFTS to a different context (r2) after the label rendered.
    editor._context = { target: { kind: 'block', ref: 'r2', label: 'B' }, caret: 9, range: null }
    editor.getSelectionContext = vi.fn(() => editor._context)
    el.querySelector('.ask-popup__input').value = 'q'
    el.querySelector('.ask-popup__send').click()
    // askAi got the CAPTURED r1 context (what was shown), not the drifted r2.
    expect(editor.askAi.mock.calls[0][0].context.target.ref).toBe('r1')
  })

  it('Enter (no shift) in the textarea sends; Escape closes', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    const ws = fakeWorkspace(editor)
    new AskPanel(ws)
    const ta = el.querySelector('.ask-popup__input')
    ta.value = 'q'
    ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(editor.askAi).toHaveBeenCalled()
    ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(ws.setPosition).toHaveBeenCalled()
  })
})

describe('AskPanel — transitional sieve:ai-* consumers (moved OUT of editor.js)', () => {
  it('sieve:ai-ask opens the panel', () => {
    const el = mountPanelDom()
    new AskPanel(fakeWorkspace(fakeEditor()))
    document.dispatchEvent(new window.CustomEvent('sieve:ai-ask'))
    expect(el.classList.contains('is-open')).toBe(true)
  })

  it('sieve:ai-explain asks with type explain + the current context (no target-prep step)', () => {
    mountPanelDom()
    const editor = fakeEditor({ kind: 'selection', ref: 'pr-1', label: 'Paragraph' }, 'wysiwyg')
    new AskPanel(fakeWorkspace(editor))
    document.dispatchEvent(new window.CustomEvent('sieve:ai-explain'))
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'explain', context: editor._context })
  })

  it('sieve:ai-explain STILL calls askAi in markdown — the editor owns the abort, not the panel', () => {
    mountPanelDom()
    const editor = fakeEditor({ kind: 'document', ref: '', label: 'Document' }, 'markdown')
    new AskPanel(fakeWorkspace(editor))
    document.dispatchEvent(new window.CustomEvent('sieve:ai-explain'))
    // The panel is dumb: it always invokes the seam; askAi no-ops explain in markdown.
    expect(editor.askAi).toHaveBeenCalledWith({ type: 'explain', context: editor._context })
  })
})

describe('AskPanel — GLOW DROPPED (P4.B)', () => {
  it('textarea focus does NOT paint an AI-target glow', () => {
    const el = mountPanelDom({ open: true })
    new AskPanel(fakeWorkspace(fakeEditor()))
    el.querySelector('.ask-popup__input').dispatchEvent(new window.FocusEvent('focus'))
    expect(setAiTargetGlow).not.toHaveBeenCalled()
  })

  it('a selection-update while the box is focused does NOT paint a glow', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    const ws = fakeWorkspace(editor)
    new AskPanel(ws)
    el.querySelector('.ask-popup__input').focus()
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph', range: { from: 1, to: 4 } } })
    expect(setAiTargetGlow).not.toHaveBeenCalled()
  })
})

describe('AskPanel — @ attachments (#74 P4)', () => {
  const AUTH = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' }
  const RETRY = { uri: 'container:1a2b', title: 'Retry RFC', kind: 'note', detail: 'rfc/' }

  /** Drives the picker: type `@au`, wait out the debounce, accept with Enter. */
  async function pickMention(ta, before, after) {
    ta.value = before + '@au' + after
    const caret = (before + '@au').length
    ta.setSelectionRange(caret, caret)
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(300)
    ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  }

  it('picking a candidate echoes @Title into the message AND adds a chip to the footer', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const panel = new AskPanel(fakeWorkspace(fakeEditor()), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' handle this?')

    expect(ta.value).toBe('How does @Auth Design handle this?')
    const chips = el.querySelectorAll('.ask-chip')
    expect(chips.length).toBe(1)
    expect(chips[0].getAttribute('data-uri')).toBe('container:9f2b')
    expect(panel).toBeTruthy()
  })

  it('send carries the manifest to askAi and then clears the chips', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' handle retries?')
    el.querySelector('.ask-popup__send').click()

    expect(editor.askAi).toHaveBeenCalledWith({
      type: 'ask',
      question: 'How does @Auth Design handle retries?',
      context: editor._context,
      attachments: [{ uri: 'container:9f2b', title: 'Auth Design' }],
    })
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)
  })

  it('SEND-TIME RECONCILIATION: an attachment whose @Title was deleted is dropped', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, '', '')
    expect(el.querySelectorAll('.ask-chip').length).toBe(1)

    // The user rewrites the message, deleting the token but not the chip.
    ta.value = 'never mind, generic question'
    el.querySelector('.ask-popup__send').click()

    expect(editor.askAi).toHaveBeenCalledWith({
      type: 'ask', question: 'never mind, generic question', context: editor._context, attachments: [],
    })
  })

  it('the ✕ on a chip detaches it before send', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, '', ' explain')
    el.querySelector('.ask-chip__remove').click()
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)

    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi.mock.calls[0][0].attachments).toEqual([])
  })

  it('a slash command carries the SAME manifest shape (attachments are not Ask-only)', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const mockCs = {
      list: () => [{ name: 'btw', description: 'by the way' }],
      resolve: vi.fn(() => ({ cmd: { name: 'btw' }, args: 'about @Auth Design' })),
      dispatch: vi.fn(() => ({ correlationId: 'c-x', onResult: vi.fn(), cancel: vi.fn() })),
    }
    new AskPanel(fakeWorkspace(fakeEditor()), mockCs, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, '/btw about ', '')
    el.querySelector('.ask-popup__send').click()

    expect(mockCs.dispatch).toHaveBeenCalledWith(
      'btw', 'about @Auth Design', expect.anything(), undefined,
      [{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  // ── The chip is a VIEW of the tokens (#74 P6) ───────────────────────────────
  //
  // Reconciliation used to run only at send, so a broken token was discovered
  // when it was too late to say so: the attachment vanished silently. The chips
  // now track the text on every edit, and the two deletion gestures each take
  // both halves.

  it('LIVE RECONCILE: breaking the token drops the chip immediately, not at send', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    new AskPanel(fakeWorkspace(fakeEditor()), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' work?')
    expect(el.querySelectorAll('.ask-chip').length).toBe(1)

    // One character out of the title — this is the state the old code claimed
    // was still attached right up until send silently dropped it.
    ta.value = 'How does @Auth Desig work?'
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))

    expect(el.querySelectorAll('.ask-chip').length).toBe(0)
  })

  it('UNDO re-attaches: the token coming back brings its chip and its manifest entry', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' work?')
    ta.value = 'How does work?'
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)

    ta.value = 'How does @Auth Design work?'
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect(el.querySelectorAll('.ask-chip').length).toBe(1)

    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi.mock.calls[0][0].attachments).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it('BACKSPACE at the token’s right edge deletes the whole token and its chip', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    new AskPanel(fakeWorkspace(fakeEditor()), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' work?')
    const edge = ta.value.indexOf('@Auth Design') + '@Auth Design'.length
    ta.setSelectionRange(edge, edge)

    const e = new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    ta.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(true)     // the composer consumed it
    expect(ta.value).toBe('How does work?')
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)
    // …and no picker is left open over the token that just went. Observed in the
    // real app before this was fixed: the list stayed up listing the deleted
    // document, and Enter would have completed into a span that no longer existed.
    const picker = /** @type {HTMLElement} */ (document.querySelector('.command-hint-popover'))
    expect(picker.style.display).toBe('none')
  })

  it('BACKSPACE anywhere else falls through as an ordinary keypress', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    new AskPanel(fakeWorkspace(fakeEditor()), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' work?')
    const before = ta.value
    ta.setSelectionRange(before.length, before.length)

    const e = new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    ta.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(false)
    expect(ta.value).toBe(before)
    expect(el.querySelectorAll('.ask-chip').length).toBe(1)
  })

  it('the ✕ removes the @Title token from the message as well as the chip', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor), undefined, undefined, fakeMentions([AUTH]))
    const ta = el.querySelector('.ask-popup__input')

    await pickMention(ta, 'How does ', ' work?')
    el.querySelector('.ask-chip__remove').click()

    expect(ta.value).toBe('How does work?')
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)
    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi.mock.calls[0][0].attachments).toEqual([])
  })

  it('a send RESETS the abandonment record — a prefix that went dry is asked again', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const mentions = fakeMentions([])          // the library answers nothing
    new AskPanel(fakeWorkspace(fakeEditor()), undefined, undefined, mentions)
    const ta = el.querySelector('.ask-popup__input')

    const typeAt = (value) => {
      ta.value = value
      ta.setSelectionRange(value.length, value.length)
      ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    }

    typeAt('@zzz')
    await vi.advanceTimersByTimeAsync(300)
    expect(mentions.search).toHaveBeenCalledTimes(1)   // dry → abandoned

    mentions.search.mockClear()
    typeAt('@zzz')
    await vi.advanceTimersByTimeAsync(300)
    expect(mentions.search).not.toHaveBeenCalled()

    // A document created mid-session would stay unfindable behind that record.
    ta.value = 'ship it'
    el.querySelector('.ask-popup__send').click()

    typeAt('@zzz')
    await vi.advanceTimersByTimeAsync(300)
    expect(mentions.search).toHaveBeenCalledTimes(1)
  })

  it('with no MentionService the panel still works — @ simply never opens a picker', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    new AskPanel(fakeWorkspace(editor))
    const ta = el.querySelector('.ask-popup__input')
    ta.value = 'plain @question'
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi.mock.calls[0][0].attachments).toEqual([])
  })
})

// ── The header shows the SUBJECT; the footer shows the CONTEXT (#74) ──────────
//
// "Ask About Document" stopped being true the moment `/btw` could be typed into
// the same box: you are not asking ABOUT the target, you are invoking a command
// that merely receives it. So the header is a VIEW OF THE COMPOSER TEXT — derived
// live, exactly as the attachment chips are — and it names the command as soon
// as the text resolves to a known one.
describe('AskPanel — the header names the verb once one is typed', () => {
  const label = (el) => el.querySelector('.ask-popup__label').textContent

  /** The REAL CommandService over a plane whose socket is never opened (nothing
   *  here dispatches): resolution is the behaviour under test, so mocking
   *  `resolve` would be testing the mock's idea of "known command". */
  function realCommands() {
    return new CommandService(new WorkspaceService({
      socketFactory: () => /** @type {any} */ ({ send() {}, close() {} }),
      wsUrl: () => 'ws://test/api/ws/workspace',
    }), { commands: [{ name: 'btw', description: 'Ask btw', family: 'ai' }] })
  }

  /** @param {HTMLElement} el @param {string} value */
  function type(el, value) {
    const ta = /** @type {HTMLTextAreaElement} */ (el.querySelector('.ask-popup__input'))
    ta.value = value
    ta.setSelectionRange(value.length, value.length)
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
  }

  it('swaps to the command the moment the text resolves to a KNOWN one, and reverts', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })), realCommands())
    panel.open()
    vi.runAllTimers()
    expect(label(el)).toBe('Ask About Document')

    type(el, '/btw')
    expect(label(el)).toBe('/btw')

    // The token goes; the header goes back with it — no send, no selection event.
    type(el, '/bt')
    expect(label(el)).toBe('Ask About Document')
  })

  it('does NOT flicker through the prefixes of a command as it is typed', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })), realCommands())
    panel.open()
    vi.runAllTimers()

    for (const prefix of ['/', '/b', '/bt']) {
      type(el, prefix)
      expect(label(el)).toBe('Ask About Document')
    }
    type(el, '/btw')
    expect(label(el)).toBe('/btw')
  })

  it('keeps naming the command while its arguments are typed', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor()), realCommands())
    panel.open()
    vi.runAllTimers()
    type(el, '/btw what did I miss')
    expect(label(el)).toBe('/btw')
  })

  it('an unknown slash word is not a verb — the header still describes the target', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor({ kind: 'block', ref: 'co-1', label: 'Code Block' })), realCommands())
    panel.open()
    vi.runAllTimers()
    type(el, '/nosuchcommand')
    expect(label(el)).toBe('Ask About Code Block')
  })

  it('a selection change does not stomp the command header', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const editor = fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })
    const ws = fakeWorkspace(editor)
    const panel = new AskPanel(ws, realCommands())
    panel.open()
    type(el, '/btw')

    editor.getSelectionContext = () => ({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: 'Paragraph' } })
    vi.runAllTimers()

    expect(label(el)).toBe('/btw')          // subject: still the command
    expect(el.querySelector('.ask-target-chip__label').textContent).toBe('Paragraph')  // context: live
  })

  it('the header reverts after a send clears the composer', () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })
    const cs = realCommands()
    vi.spyOn(cs, 'dispatch').mockReturnValue(/** @type {any} */ ({ correlationId: 'c-1', onResult: vi.fn(), cancel: vi.fn() }))
    const panel = new AskPanel(fakeWorkspace(editor), cs)
    panel.open()
    vi.runAllTimers()
    type(el, '/btw what did I miss')
    expect(label(el)).toBe('/btw')

    el.querySelector('.ask-popup__send').click()
    expect(label(el)).toBe('Ask About Document')
  })

  it('with no CommandService the header is unchanged by a slash', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })))
    panel.open()
    vi.runAllTimers()
    type(el, '/btw')
    expect(label(el)).toBe('Ask About Document')
  })
})

// ── The target renders as chips in the footer (#74) ───────────────────────────
//
// A target chip is NOT an attachment: the editor owns the selection and the
// panel merely draws it, so it carries no ✕ (the cross keeps exactly one
// meaning — drop an attachment) and it never reaches the manifest.
describe('AskPanel — the footer shows what the message will act on', () => {
  const targetChips = (el) => el.querySelectorAll('.ask-target-chip')

  it('renders ONE view-only chip for the target, with no remove affordance', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor({ kind: 'block', ref: 'co-1', label: 'Code Block' })))
    panel.open()
    vi.runAllTimers()

    const chips = targetChips(el)
    expect(chips.length).toBe(1)
    expect(chips[0].querySelector('.ask-target-chip__label').textContent).toBe('Code Block')
    expect(chips[0].querySelector('button')).toBe(null)          // no ✕: the editor owns the selection
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)      // and it is not an attachment chip
  })

  it('tracks the selection stream', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const editor = fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })
    const ws = fakeWorkspace(editor)
    const panel = new AskPanel(ws)
    panel.open()
    vi.runAllTimers()
    expect(targetChips(el)[0].textContent).toContain('Document')

    editor.getSelectionContext = () => ({ target: { kind: 'selection', ref: 'pr-1', label: '“retry policy”' } })
    ws.emit({ target: { kind: 'selection', ref: 'pr-1', label: '“retry policy”' } })
    vi.runAllTimers()
    expect(targetChips(el)[0].textContent).toContain('“retry policy”')
  })

  it('is NOT an attachment: it never reaches the manifest, and a send leaves it standing', async () => {
    vi.useFakeTimers()
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })
    const panel = new AskPanel(fakeWorkspace(editor), undefined, undefined,
      fakeMentions([{ uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' }]))
    panel.open()
    vi.runAllTimers()

    const ta = /** @type {HTMLTextAreaElement} */ (el.querySelector('.ask-popup__input'))
    ta.value = 'How does @au'
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(300)
    ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    // One of each in the footer, told apart by class — and only one is removable.
    expect(targetChips(el).length).toBe(1)
    expect(el.querySelectorAll('.ask-chip').length).toBe(1)
    expect(el.querySelectorAll('.ask-chip__remove').length).toBe(1)

    el.querySelector('.ask-popup__send').click()
    expect(editor.askAi.mock.calls[0][0].attachments).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
    // The attachment chip clears with the message; the target belongs to the
    // editor, so it is still there.
    expect(el.querySelectorAll('.ask-chip').length).toBe(0)
    expect(targetChips(el).length).toBe(1)
  })

  it('renders nothing before the panel has a context', () => {
    const el = mountPanelDom()
    new AskPanel(fakeWorkspace(null))
    expect(targetChips(el).length).toBe(0)
  })

  it('THE FOOTER IS CHIPS + SEND: nothing yields, because the chord hint is in the placeholder (#82)', () => {
    // The chord used to be a footer span the chips displaced, which made the two
    // rows fight over one slot AND took "Enter to send" away exactly when the
    // composer was busiest. It is the composer's placeholder now, so the footer's
    // whole contract is: the two chip rows, then Send.
    vi.useFakeTimers()
    const el = mountPanelDom()
    const panel = new AskPanel(fakeWorkspace(fakeEditor({ kind: 'document', ref: 'doc', label: 'Document' })))
    panel.open()
    vi.runAllTimers()

    const footer = el.querySelector('.ask-popup__footer')
    expect(Array.from(footer.children).map((c) => c.className.split(' ')[0]))
      .toEqual(['ask-popup__target', 'ask-popup__chips', 'ask-popup__send'])
    expect(el.querySelector('.ask-popup__hint')).toBe(null)
    expect(targetChips(el).length).toBe(1)
  })

  it('a SELECTION gets a chip per block, labelled from the workspace BlockService (#82)', () => {
    vi.useFakeTimers()
    const el = mountPanelDom()
    const ws = fakeWorkspace(fakeEditor({ kind: 'selection', ref: 'b1,b2', label: '“retry policy”' }))
    ws._editor.getSelectionContext = () => ({
      target: { kind: 'selection', ref: 'b1,b2', label: '“retry policy”' },
      blockIds: ['b1', 'b2'],
    })
    ws.blockService = {
      envelopeFor: (id) => (id === 'b2' ? new SieveBlock('code', { language: 'go' }) : null),
      kindFor: (id) => (id === 'b1' ? 'prose' : 'code'),
    }
    const panel = new AskPanel(ws)
    panel.open()
    vi.runAllTimers()

    const labels = Array.from(targetChips(el))
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
    /** @type {((block: any) => void)[]} */ const listeners = []
    ws.blockService = {
      envelopeFor: () => new SieveBlock('code', { language }),
      kindFor: () => 'code',
    }
    ws.documentService = {
      onBlockUpdated: (uuid, fn) => { listeners.push(fn); return () => {} },
    }
    const el = mountPanelDom()
    const panel = new AskPanel(ws)
    panel.open()
    vi.runAllTimers()
    const language1 = () => targetChips(el)[1].querySelector('.ask-target-chip__label').textContent
    expect(language1()).toBe('go')

    // The caret has not moved — only the block's own truth changed.
    language = 'rust'
    listeners.forEach((fn) => fn({ id: 'b2' }))
    expect(language1()).toBe('rust')
  })
})

describe('AskPanel — Slash command routing (#55)', () => {
  it('dispatches valid slash command via commandService and clears box', () => {
    const el = mountPanelDom({ open: true })
    const editor = fakeEditor()
    const ws = fakeWorkspace(editor)
    const mockCs = {
      // list() is part of the CommandService contract the `/` provider consumes.
      list: () => [{ name: 'btw', description: 'Ask btw' }],
      resolve: vi.fn((input) => input.startsWith('/btw') ? { cmd: { name: 'btw', description: 'Ask btw' }, args: 'what is X' } : null),
      // Returns a dispatch handle; the badge (not the panel) wires onResult.
      dispatch: vi.fn(() => ({ correlationId: 'c-x', onResult: vi.fn(), cancel: vi.fn() }))
    }
    const panel = new AskPanel(ws, mockCs)
    const ta = el.querySelector('.ask-popup__input')
    ta.value = '/btw what is X'
    el.querySelector('.ask-popup__send').click()

    expect(mockCs.resolve).toHaveBeenCalledWith('/btw what is X')
    // Dispatched with NO onResult callback — the dead editor.handleCommandResult
    // seam was removed; the badge owns the result lifecycle via handle.onResult.
    expect(mockCs.dispatch).toHaveBeenCalledWith('btw', 'what is X', expect.anything(), undefined, [])
    expect(editor.askAi).not.toHaveBeenCalled()
    expect(ta.value).toBe('')
  })

  it('a command send while pinned keeps the panel open (no dismiss-on-send)', () => {
    window.initAskPanelPinned = true
    const el = mountPanelDom({ open: true })
    const ws = fakeWorkspace(fakeEditor())
    const mockCs = {
      list: () => [{ name: 'btw', description: 'Ask btw' }],
      resolve: vi.fn(() => ({ cmd: { name: 'btw', description: 'Ask btw' }, args: 'x' })),
      dispatch: vi.fn(() => ({ correlationId: 'c-x', onResult: vi.fn(), cancel: vi.fn() }))
    }
    const panel = new AskPanel(ws, mockCs)
    const ta = el.querySelector('.ask-popup__input')
    ta.value = '/btw x'
    el.querySelector('.ask-popup__send').click()

    expect(mockCs.dispatch).toHaveBeenCalled()
    expect(ta.value).toBe('')
    expect(el.classList.contains('is-open')).toBe(true)   // pinned → send never unpins
  })
})
