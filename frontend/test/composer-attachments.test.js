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

describe('ComposerAttachments — send-time reconciliation', () => {
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
  })
})
