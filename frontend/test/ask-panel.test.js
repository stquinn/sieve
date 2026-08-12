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
      <textarea class="ask-popup__input" placeholder="Ask a question…" spellcheck="false"></textarea>
      <div class="ask-popup__footer">
        <span class="ask-popup__hint">Enter to send</span>
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
      expect(ajax).toHaveBeenCalledWith('POST', '/api/session/askpanel/toggle', { swap: 'none' })
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
    // The chips displace the hint while an attachment is present.
    expect(el.querySelector('.ask-popup__hint').style.display).toBe('none')
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
    expect(el.querySelector('.ask-popup__hint').style.display).not.toBe('none')
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
