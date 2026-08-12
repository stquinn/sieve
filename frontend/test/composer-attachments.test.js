// @ts-check
// composer-attachments.test.js — the Ask composer's attachment model + chip row
// (#74 P4). The model is PANEL STATE: it holds what the user attached, renders
// the chips into the EXISTING .ask-popup__footer (displacing the hint), and
// reconciles against the message text at send time.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComposerAttachments } from '../src/static/shell/composer-attachments.js'

function mountFooter() {
  document.body.innerHTML = `
    <div id="ask-panel" class="ask-panel">
      <textarea class="ask-popup__input"></textarea>
      <div class="ask-popup__footer">
        <span class="ask-popup__hint">Enter to send · Shift+Enter for new line</span>
        <button class="ask-popup__send">Send</button>
      </div>
    </div>`
  return /** @type {HTMLElement} */ (document.querySelector('.ask-popup__footer'))
}

/** The footer AND the composer the tokens live in — the bound (non-headless) model. */
function mountComposer() {
  const footer = mountFooter()
  const textarea = /** @type {HTMLTextAreaElement} */ (document.querySelector('.ask-popup__input'))
  return { footer, textarea }
}

const chips = () => Array.from(document.querySelectorAll('.ask-chip'))
const hint = () => /** @type {HTMLElement} */ (document.querySelector('.ask-popup__hint'))

const AUTH = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/ · #auth' }
const RETRY = { uri: 'container:1a2b', title: 'Retry RFC', kind: 'note', detail: 'rfc/' }

describe('ComposerAttachments — the model', () => {
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => { model = new ComposerAttachments(mountFooter()) })
  afterEach(() => { document.body.innerHTML = '' })

  it('adds an attachment and reports it in the persisted {uri,title} shape only', () => {
    expect(model.add(AUTH)).toBe(true)
    expect(model.size).toBe(1)
    // kind/summary are resolved server-side at job time — they are NEVER persisted.
    expect(model.manifest()).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it('ignores a candidate with no address (an address-less attachment is not one)', () => {
    expect(model.add(/** @type {any} */ ({ title: 'No address' }))).toBe(false)
    expect(model.add(/** @type {any} */ (null))).toBe(false)
    expect(model.size).toBe(0)
  })

  it('attaching the same document twice is idempotent (dedupe by uri)', () => {
    expect(model.add(AUTH)).toBe(true)
    expect(model.add({ ...AUTH })).toBe(false)
    expect(model.size).toBe(1)
  })

  it('removes by uri', () => {
    model.add(AUTH)
    model.add(RETRY)
    model.remove('container:9f2b')
    expect(model.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
  })

  it('clear() empties the set', () => {
    model.add(AUTH)
    model.clear()
    expect(model.size).toBe(0)
    expect(model.manifest()).toEqual([])
  })
})

describe('ComposerAttachments — reconciliation against the message text', () => {
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => { model = new ComposerAttachments(mountFooter()) })
  afterEach(() => { document.body.innerHTML = '' })

  it('keeps an attachment whose @Title token is still in the message', () => {
    model.add(AUTH)
    expect(model.reconcile('How does @Auth Design handle this?')).toEqual([
      { uri: 'container:9f2b', title: 'Auth Design' },
    ])
    expect(model.size).toBe(1)
  })

  it('DROPS an attachment whose @Title token was deleted from the message', () => {
    model.add(AUTH)
    model.add(RETRY)
    expect(model.reconcile('How does @Retry RFC work?')).toEqual([
      { uri: 'container:1a2b', title: 'Retry RFC' },
    ])
    expect(chips().length).toBe(1)
  })

  it('a token at the very start of the message counts', () => {
    model.add(AUTH)
    expect(model.reconcile('@Auth Design — summarise it').length).toBe(1)
  })

  it('a title glued to a preceding word is NOT the token', () => {
    model.add(AUTH)
    expect(model.reconcile('mail me@Auth Design')).toEqual([])
  })

  it('DUPLICATE TITLES: two "Notes" with different uris both survive two tokens', () => {
    const a = { uri: 'container:aaa', title: 'Notes', detail: 'design/' }
    const b = { uri: 'container:bbb', title: 'Notes', detail: 'journal/' }
    model.add(a)
    model.add(b)
    // The ambiguity lives only in the text echo; the data carries two addresses.
    expect(model.reconcile('how do @Notes and @Notes differ?')).toEqual([
      { uri: 'container:aaa', title: 'Notes' },
      { uri: 'container:bbb', title: 'Notes' },
    ])
  })

  it('DUPLICATE TITLES: deleting one @Notes token drops exactly one attachment', () => {
    model.add({ uri: 'container:aaa', title: 'Notes' })
    model.add({ uri: 'container:bbb', title: 'Notes' })
    expect(model.reconcile('what is in @Notes?')).toEqual([{ uri: 'container:aaa', title: 'Notes' }])
    expect(model.size).toBe(1)
  })
})

describe('ComposerAttachments — the chip row in the existing footer', () => {
  /** @type {HTMLElement} */ let footer
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => { footer = mountFooter(); model = new ComposerAttachments(footer) })
  afterEach(() => { document.body.innerHTML = '' })

  it('adds NO new row to the panel — the chips live inside .ask-popup__footer', () => {
    model.add(AUTH)
    const row = footer.querySelector('.ask-popup__chips')
    expect(row).not.toBeNull()
    expect(row?.parentElement).toBe(footer)
    // The Send button stays the footer's last child (chips take the LEFT region).
    expect(footer.lastElementChild?.className).toBe('ask-popup__send')
  })

  it('chips DISPLACE the hint while any attachment is present, and it returns when empty', () => {
    expect(hint().style.display).not.toBe('none')
    model.add(AUTH)
    expect(hint().style.display).toBe('none')
    model.remove(AUTH.uri)
    expect(hint().style.display).not.toBe('none')
  })

  it('renders one chip per attachment, carrying the uri (not the title) as identity', () => {
    model.add(AUTH)
    model.add(RETRY)
    expect(chips().map((c) => c.getAttribute('data-uri'))).toEqual(['container:9f2b', 'container:1a2b'])
    expect(chips()[0].textContent).toContain('Auth Design')
  })

  it('duplicate titles render as two distinct chips (the detail tells them apart)', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    expect(chips().length).toBe(2)
    expect(chips().map((c) => c.getAttribute('title'))).toEqual(['design/', 'journal/'])
  })

  it('the ✕ on a chip removes that attachment', () => {
    model.add(AUTH)
    model.add(RETRY)
    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()
    expect(model.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
    expect(chips().length).toBe(1)
  })

  it('null-guards a missing footer (headless boot) — every verb still works', () => {
    document.body.innerHTML = ''
    const headless = new ComposerAttachments(null)
    expect(() => { headless.add(AUTH); headless.remove(AUTH.uri); headless.clear() }).not.toThrow()
    headless.add(RETRY)
    expect(headless.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
    // With no composer bound there is no token to delete and nothing to consume.
    expect(headless.detachAt(0)).toBe(false)
  })
})

// ── The chip is a VIEW of the tokens (#74 P6) ────────────────────────────────
//
// The defect these pin: reconciliation used to run ONLY at send, so a chip could
// sit there claiming "attached" over a token the user had already broken, and the
// attachment was dropped silently at send. The chip now follows the text on every
// edit, and the two deletion gestures — Backspace at the token's right edge, and
// the chip's ✕ — each remove BOTH halves.

describe('ComposerAttachments — atomic token deletion', () => {
  /** @type {HTMLTextAreaElement} */ let ta
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    ta = composer.textarea
    model = new ComposerAttachments(composer.footer, ta)
  })
  afterEach(() => { document.body.innerHTML = '' })

  /** Puts the caret at the right edge of `token` and returns that index. */
  function caretAfter(token) {
    const at = ta.value.indexOf(token) + token.length
    ta.setSelectionRange(at, at)
    return at
  }

  it('deletes the WHOLE token and its chip in one press', () => {
    model.add(AUTH)
    ta.value = 'How does @Auth Design handle this?'
    model.reconcile(ta.value)
    expect(chips().length).toBe(1)

    expect(model.detachAt(caretAfter('@Auth Design'))).toBe(true)
    // The token AND the gap it sat in go: deleting a word must not leave a hole.
    expect(ta.value).toBe('How does handle this?')
    expect(chips().length).toBe(0)
    expect(model.manifest()).toEqual([])
  })

  it('leaves the caret where the token started', () => {
    model.add(AUTH)
    ta.value = 'How does @Auth Design handle this?'
    model.reconcile(ta.value)
    model.detachAt(caretAfter('@Auth Design'))
    expect(ta.selectionStart).toBe(9)
    expect(ta.selectionEnd).toBe(9)
  })

  it('does NOTHING when the caret is not at a token edge — an ordinary Backspace', () => {
    model.add(AUTH)
    ta.value = 'How does @Auth Design handle this?'
    model.reconcile(ta.value)

    expect(model.detachAt(5)).toBe(false)                    // mid-word
    expect(model.detachAt(ta.value.length)).toBe(false)      // end of the message
    expect(model.detachAt(ta.value.indexOf('@Auth Design'))).toBe(false)  // LEFT edge
    expect(ta.value).toBe('How does @Auth Design handle this?')
    expect(chips().length).toBe(1)
  })

  it('does not fire on text that merely LOOKS like a token (nothing was accepted)', () => {
    ta.value = 'ask @Auth Design about it'
    expect(model.detachAt('ask @Auth Design'.length)).toBe(false)
    expect(ta.value).toBe('ask @Auth Design about it')
  })

  it('DUPLICATE TITLES: deleting the first token leaves the OTHER attachment attached', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    ta.value = '@Notes and @Notes differ'
    model.reconcile(ta.value)
    expect(chips().length).toBe(2)

    expect(model.detachAt('@Notes'.length)).toBe(true)
    expect(ta.value).toBe('and @Notes differ')
    // Detaching DEMOTES: the surviving token pairs with the one the user did not
    // touch, not with the one whose text just went.
    expect(model.manifest()).toEqual([{ uri: 'container:bbb', title: 'Notes' }])
    expect(chips().map((c) => c.getAttribute('title'))).toEqual(['journal/'])
  })
})

describe('ComposerAttachments — the ✕ removes the text token too', () => {
  /** @type {HTMLTextAreaElement} */ let ta
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    ta = composer.textarea
    model = new ComposerAttachments(composer.footer, ta)
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('deletes the @Title echo from the message, not just the chip', () => {
    model.add(AUTH)
    model.add(RETRY)
    ta.value = 'compare @Auth Design with @Retry RFC please'
    model.reconcile(ta.value)

    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()

    expect(ta.value).toBe('compare with @Retry RFC please')
    expect(model.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
    expect(chips().length).toBe(1)
  })

  it('DUPLICATE TITLES: the ✕ takes exactly that chip and exactly one token', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    ta.value = 'how do @Notes and @Notes differ?'
    model.reconcile(ta.value)

    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()

    expect(ta.value).toBe('how do and @Notes differ?')
    expect(model.manifest()).toEqual([{ uri: 'container:bbb', title: 'Notes' }])
  })

  it('still detaches when the token is already gone from the message', () => {
    model.add(AUTH)
    ta.value = 'no token here'
    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()
    expect(ta.value).toBe('no token here')
    expect(model.manifest()).toEqual([])
  })
})

// The ✕ and a text edit are the SAME mechanism but not the same intent: ✕ says
// "I do not want this attached", editing says "I am editing my sentence". So ✕
// forgets the document out of the pool and a text edit does not — which is also
// what keeps Ctrl+Z able to restore a chip a keystroke removed.
describe('ComposerAttachments — the ✕ forgets, a text edit does not', () => {
  /** @type {HTMLTextAreaElement} */ let ta
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    ta = composer.textarea
    model = new ComposerAttachments(composer.footer, ta)
  })
  afterEach(() => { document.body.innerHTML = '' })

  /** Clicks the ✕ on the nth chip. */
  const removeChip = (n = 0) =>
    /** @type {HTMLElement} */ (chips()[n].querySelector('.ask-chip__remove')).click()

  it('the ✕ FORGETS: writing the same title afterwards stays plain prose', () => {
    model.add(AUTH)
    ta.value = 'How does @Auth Design handle this?'
    model.reconcile(ta.value)
    removeChip()
    expect(model.size).toBe(0)

    // The whole point: a removal is FINAL. Without forgetting, this silently
    // re-attaches the document the user just refused.
    ta.value = 'as @Auth Design says…'
    expect(model.reconcile(ta.value)).toEqual([])
    expect(chips().length).toBe(0)
  })

  it('an atomic Backspace does NOT forget — the same title typed back re-attaches', () => {
    model.add(AUTH)
    ta.value = 'How does @Auth Design handle this?'
    model.reconcile(ta.value)
    expect(model.detachAt('How does @Auth Design'.length)).toBe(true)
    expect(model.size).toBe(0)

    ta.value = 'as @Auth Design says…'
    expect(model.reconcile(ta.value)).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it("a ✕'d document attaches again when accepted from the picker a second time", () => {
    model.add(AUTH)
    ta.value = '@Auth Design'
    model.reconcile(ta.value)
    removeChip()

    expect(model.add(AUTH)).toBe(true)
    expect(model.reconcile('@Auth Design')).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it('DUPLICATE TITLES: ✕ forgets only the removed uri, and the survivor keeps the OTHER document', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    ta.value = 'how do @Notes and @Notes differ?'
    model.reconcile(ta.value)

    removeChip()                                          // ✕ on design/ (aaa)
    expect(ta.value).toBe('how do and @Notes differ?')
    expect(model.manifest()).toEqual([{ uri: 'container:bbb', title: 'Notes' }])

    // Forgetting is per-URI, not per-title: bbb is untouched, so putting a second
    // @Notes back gives ONE chip — bbb's — not two.
    ta.value = 'how do @Notes and @Notes differ?'
    expect(model.reconcile(ta.value)).toEqual([{ uri: 'container:bbb', title: 'Notes' }])
    expect(chips().map((c) => c.getAttribute('title'))).toEqual(['journal/'])
  })
})

describe('ComposerAttachments — a token that comes back re-attaches', () => {
  /** @type {HTMLTextAreaElement} */ let ta
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    ta = composer.textarea
    model = new ComposerAttachments(composer.footer, ta)
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('UNDO restores the chip — matching is on the title text, so the pool re-pairs', () => {
    model.add(AUTH)
    ta.value = 'How does @Auth Design handle this?'
    model.reconcile(ta.value)
    expect(chips().length).toBe(1)

    // Selected through the token and deleted (or cut, or pasted over).
    ta.value = 'How does handle this?'
    expect(model.reconcile(ta.value)).toEqual([])
    expect(chips().length).toBe(0)

    // …and undone.
    ta.value = 'How does @Auth Design handle this?'
    expect(model.reconcile(ta.value)).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
    expect(chips().length).toBe(1)
    expect(chips()[0].getAttribute('data-uri')).toBe('container:9f2b')
  })

  it('undoing an atomic Backspace brings the chip back with it', () => {
    model.add(AUTH)
    ta.value = '@Auth Design summarise'
    model.reconcile(ta.value)
    expect(model.detachAt('@Auth Design'.length)).toBe(true)
    expect(chips().length).toBe(0)

    ta.value = '@Auth Design summarise'
    model.reconcile(ta.value)
    expect(chips().length).toBe(1)
  })

  it('clear() forgets the pool — a title typed after a send does not resurrect a chip', () => {
    model.add(AUTH)
    model.clear()
    expect(model.reconcile('@Auth Design')).toEqual([])
    expect(chips().length).toBe(0)
  })

  it('re-accepting a document whose token was deleted attaches it again', () => {
    model.add(AUTH)
    ta.value = 'nothing here'
    model.reconcile(ta.value)
    expect(model.size).toBe(0)
    expect(model.add(AUTH)).toBe(true)
    expect(model.size).toBe(1)
  })
})
