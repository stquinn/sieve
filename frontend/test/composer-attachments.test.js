// @ts-check
// composer-attachments.test.js — the Ask composer's attachment chips (#74 P4,
// re-sourced onto the draft in #118). THE TRUTH IS THE DRAFT: accepting a
// candidate mints one attach-rel reference element into the draft container, and
// the chips in the EXISTING .ask-popup__footer are a view of it paired against
// the message text.
//
// WHAT A DRAFT IS here is the three things this type reaches for — read the
// text, cut a span out of it, and the container — so what is driven below is a
// REAL InMemoryContainerProvider and never a stand-in for one: the element
// shape is the thing under test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComposerAttachments } from '../src/static/shell/composer-attachments.js'
import { InMemoryContainerProvider } from '../src/static/container/in-memory-container-provider.js'
import { QuestionList } from '../src/static/renderers/question-list.js'

function mountFooter() {
  document.body.innerHTML = `
    <div id="ask-panel" class="ask-panel">
      <div class="ask-popup__input"></div>
      <div class="ask-popup__footer">
        <button class="ask-popup__send">Send</button>
      </div>
    </div>`
  return /** @type {HTMLElement} */ (document.querySelector('.ask-popup__footer'))
}

/** A draft, as flat as this type sees one: the text verbs, and the container the
 *  attachments are blocks of. `retire()` is what a reset does — a different
 *  container, so what the old one held is simply gone. */
function fakeDraft(initial = '') {
  let value = initial
  let provider = new InMemoryContainerProvider()
  return {
    read: () => value,
    cut: (start, end) => { value = value.slice(0, start) + value.slice(end) },
    set: (next) => { value = next },
    get provider() { return provider },
    retire: () => { provider = new InMemoryContainerProvider(); value = '' },
  }
}

/** The footer AND the draft the elements and tokens live in. */
function mountComposer() {
  const footer = mountFooter()
  return { footer, message: fakeDraft() }
}

/** The draft's attach-rel reference elements, in container order. */
function elementsOf(draft) {
  return draft.provider.getOrder()
    .map((/** @type {string} */ id) => draft.provider.getBlock(id))
    .filter((/** @type {any} */ n) => !!QuestionList.attachmentOf(n))
}

const chips = () => Array.from(document.querySelectorAll('.ask-chip'))

const AUTH = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/ · #auth' }
const RETRY = { uri: 'container:1a2b', title: 'Retry RFC', kind: 'note', detail: 'rfc/' }

describe('ComposerAttachments — the model', () => {
  /** @type {ComposerAttachments} */ let model
  /** @type {ReturnType<typeof fakeDraft>} */ let draft

  beforeEach(() => { draft = fakeDraft(); model = new ComposerAttachments(mountFooter(), draft) })
  afterEach(() => { document.body.innerHTML = '' })

  it('adds an attachment and reports it in the persisted {uri,title} shape only', () => {
    expect(model.add(AUTH)).toBe(true)
    expect(model.size).toBe(1)
    // kind/summary are resolved server-side at job time — they are NEVER persisted.
    expect(model.manifest()).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  // THE RULING (#118): accepting is a HOST WRITE into the draft. What lands is a
  // question element wearing its role stamp — the same one a scalar ask mints —
  // named by a draft-local uuid the harvest strips.
  it('ACCEPT MINTS ONE ELEMENT into the draft: a reference declaring attach', () => {
    model.add(AUTH)
    const [node] = elementsOf(draft)
    expect(node.kind).toBe('reference')
    expect(node.attrs.rel).toBe('attach')
    expect(node.attrs.uri).toBe('container:9f2b')
    expect(node.attrs.cache).toEqual({ title: 'Auth Design' })
    expect(node.id).toBeTruthy()
  })

  it('the element is what the chips and the manifest are BOTH read from', () => {
    model.add(AUTH)
    model.add(RETRY)
    expect(elementsOf(draft).map((n) => n.attrs.uri)).toEqual(['container:9f2b', 'container:1a2b'])
    expect(model.manifest().map((a) => a.uri)).toEqual(['container:9f2b', 'container:1a2b'])
  })

  it('attaches nothing when there is no draft to attach to', () => {
    const headless = new ComposerAttachments(mountFooter())
    expect(headless.add(AUTH)).toBe(false)
    expect(headless.manifest()).toEqual([])
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

  it('removes by uri, and the element leaves the draft with the chip', () => {
    model.add(AUTH)
    model.add(RETRY)
    model.remove('container:9f2b')
    expect(model.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
    expect(elementsOf(draft).map((n) => n.attrs.uri)).toEqual(['container:1a2b'])
  })

  it('A RETIRED DRAFT TAKES ITS ATTACHMENTS WITH IT — nothing here to empty', () => {
    model.add(AUTH)
    draft.retire()
    expect(model.reconcile('@Auth Design')).toEqual([])
    expect(model.size).toBe(0)
  })

  it('titles() names what an @Title token in the message points at', () => {
    model.add(AUTH)
    model.add(RETRY)
    expect(model.titles()).toEqual(['Auth Design', 'Retry RFC'])
  })

  it('titles() drops a titleless attachment — there is no token to find for one', () => {
    model.add({ uri: 'container:ccc', title: '' })
    expect(model.size).toBe(1)
    expect(model.titles()).toEqual([])
  })
})

describe('ComposerAttachments — reconciliation against the message text', () => {
  /** @type {ComposerAttachments} */ let model
  /** @type {ReturnType<typeof fakeDraft>} */ let draft

  beforeEach(() => { draft = fakeDraft(); model = new ComposerAttachments(mountFooter(), draft) })
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

  // Reconciling never touches the draft — a text edit is editing a sentence, and
  // the element it leaves standing is what lets an undone deletion re-attach.
  // SEND is where the difference is settled, because the harvest reads the draft.
  it('reconciling leaves the element standing, however the text moved', () => {
    model.add(AUTH)
    draft.set('nothing about it any more')
    expect(model.reconcile(draft.read())).toEqual([])
    expect(elementsOf(draft).length).toBe(1)
  })

  it('COMMIT settles the draft: an element with no token left is cut out of it', () => {
    model.add(AUTH)
    model.add(RETRY)
    draft.set('only @Retry RFC survives')
    expect(model.commit()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
    expect(elementsOf(draft).map((n) => n.attrs.uri)).toEqual(['container:1a2b'])
  })

  it('COMMIT keeps every element a token still carries', () => {
    model.add(AUTH)
    draft.set('How does @Auth Design handle this?')
    expect(model.commit()).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
    expect(elementsOf(draft).length).toBe(1)
  })
})

describe('ComposerAttachments — the chip row in the existing footer', () => {
  /** @type {HTMLElement} */ let footer
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => { footer = mountFooter(); model = new ComposerAttachments(footer, fakeDraft()) })
  afterEach(() => { document.body.innerHTML = '' })

  it('adds NO new row to the panel — the chips live inside .ask-popup__footer', () => {
    model.add(AUTH)
    const row = footer.querySelector('.ask-popup__chips')
    expect(row).not.toBeNull()
    expect(row?.parentElement).toBe(footer)
    // The Send button stays the footer's last child (chips take the LEFT region).
    expect(footer.lastElementChild?.className).toBe('ask-popup__send')
  })

  it('ADDS EXACTLY ONE ROW and nothing else — the rest of the footer is other owners\'', () => {
    model.add(AUTH)
    const footer = /** @type {HTMLElement} */ (document.querySelector('.ask-popup__footer'))
    expect(Array.from(footer.children).map((c) => c.className.split(' ')[0]))
      .toEqual(['ask-popup__chips', 'ask-popup__send'])
  })

  // The picker's `kind`/`detail` are dressing for CHOOSING, and the draft's
  // element carries neither: a chip says what the attachment is — its title, and
  // its address for the eye that needs to tell two of them apart.
  it('a chip says the title and nothing the picker made up', () => {
    model.add(AUTH)
    expect(chips()[0].querySelector('.ask-chip__kind')).toBe(null)
    expect(chips()[0].getAttribute('title')).toBe('container:9f2b')
  })

  it('renders one chip per attachment, carrying the uri (not the title) as identity', () => {
    model.add(AUTH)
    model.add(RETRY)
    expect(chips().map((c) => c.getAttribute('data-uri'))).toEqual(['container:9f2b', 'container:1a2b'])
    expect(chips()[0].textContent).toContain('Auth Design')
  })

  it('duplicate titles render as two distinct chips (the address tells them apart)', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    expect(chips().length).toBe(2)
    expect(chips().map((c) => c.getAttribute('title'))).toEqual(['container:aaa', 'container:bbb'])
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
    const headless = new ComposerAttachments(null, fakeDraft())
    expect(() => { headless.add(AUTH); headless.remove(AUTH.uri); headless.commit() }).not.toThrow()
    headless.add(RETRY)
    expect(headless.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
  })
})

// ── The chip is a VIEW of the tokens (#74 P6) ────────────────────────────────
//
// The defect these pin: reconciliation used to run ONLY at send, so a chip could
// sit there claiming "attached" over a token the user had already broken, and the
// attachment was dropped silently at send. The chip now follows the message on
// every edit, and the chip's ✕ removes BOTH halves.

describe('ComposerAttachments — the ✕ removes the text token too', () => {
  /** @type {ReturnType<typeof fakeMessage>} */ let message
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    message = composer.message
    model = new ComposerAttachments(composer.footer, message)
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('deletes the @Title echo from the message, not just the chip', () => {
    model.add(AUTH)
    model.add(RETRY)
    message.set('compare @Auth Design with @Retry RFC please')
    model.reconcile(message.read())

    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()

    expect(message.read()).toBe('compare with @Retry RFC please')
    expect(model.manifest()).toEqual([{ uri: 'container:1a2b', title: 'Retry RFC' }])
    expect(chips().length).toBe(1)
  })

  it('DUPLICATE TITLES: the ✕ takes exactly that chip and exactly one token', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    message.set('how do @Notes and @Notes differ?')
    model.reconcile(message.read())

    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()

    expect(message.read()).toBe('how do and @Notes differ?')
    expect(model.manifest()).toEqual([{ uri: 'container:bbb', title: 'Notes' }])
  })

  it('still detaches when the token is already gone from the message', () => {
    model.add(AUTH)
    message.set('no token here')
    const remove = /** @type {HTMLElement} */ (chips()[0].querySelector('.ask-chip__remove'))
    remove.click()
    expect(message.read()).toBe('no token here')
    expect(model.manifest()).toEqual([])
  })
})

// The ✕ and a text edit are the SAME mechanism but not the same intent: ✕ says
// "I do not want this attached", editing says "I am editing my sentence". So ✕
// forgets the document out of the pool and a text edit does not — which is also
// what keeps Ctrl+Z able to restore a chip a keystroke removed.
describe('ComposerAttachments — the ✕ forgets, a text edit does not', () => {
  /** @type {ReturnType<typeof fakeMessage>} */ let message
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    message = composer.message
    model = new ComposerAttachments(composer.footer, message)
  })
  afterEach(() => { document.body.innerHTML = '' })

  /** Clicks the ✕ on the nth chip. */
  const removeChip = (n = 0) =>
    /** @type {HTMLElement} */ (chips()[n].querySelector('.ask-chip__remove')).click()

  it('the ✕ FORGETS: writing the same title afterwards stays plain prose', () => {
    model.add(AUTH)
    message.set('How does @Auth Design handle this?')
    model.reconcile(message.read())
    removeChip()
    expect(model.size).toBe(0)

    // The whole point: a removal is FINAL. Without forgetting, this silently
    // re-attaches the document the user just refused.
    message.set('as @Auth Design says…')
    expect(model.reconcile(message.read())).toEqual([])
    expect(chips().length).toBe(0)
  })

  it('a TEXT EDIT does NOT forget — the same title typed back re-attaches', () => {
    model.add(AUTH)
    message.set('How does @Auth Design handle this?')
    model.reconcile(message.read())
    message.set('How does handle this?')
    expect(model.reconcile(message.read())).toEqual([])

    message.set('as @Auth Design says…')
    expect(model.reconcile(message.read())).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it("a ✕'d document attaches again when accepted from the picker a second time", () => {
    model.add(AUTH)
    message.set('@Auth Design')
    model.reconcile(message.read())
    removeChip()

    expect(model.add(AUTH)).toBe(true)
    expect(model.reconcile('@Auth Design')).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
  })

  it('DUPLICATE TITLES: ✕ forgets only the removed uri, and the survivor keeps the OTHER document', () => {
    model.add({ uri: 'container:aaa', title: 'Notes', detail: 'design/' })
    model.add({ uri: 'container:bbb', title: 'Notes', detail: 'journal/' })
    message.set('how do @Notes and @Notes differ?')
    model.reconcile(message.read())

    removeChip()                                          // ✕ on design/ (aaa)
    expect(message.read()).toBe('how do and @Notes differ?')
    expect(model.manifest()).toEqual([{ uri: 'container:bbb', title: 'Notes' }])

    // Forgetting is per-URI, not per-title: bbb is untouched, so putting a second
    // @Notes back gives ONE chip — bbb's — not two.
    message.set('how do @Notes and @Notes differ?')
    expect(model.reconcile(message.read())).toEqual([{ uri: 'container:bbb', title: 'Notes' }])
    expect(chips().map((c) => c.getAttribute('title'))).toEqual(['container:bbb'])
  })
})

describe('ComposerAttachments — a token that comes back re-attaches', () => {
  /** @type {ReturnType<typeof fakeMessage>} */ let message
  /** @type {ComposerAttachments} */ let model

  beforeEach(() => {
    const composer = mountComposer()
    message = composer.message
    model = new ComposerAttachments(composer.footer, message)
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('UNDO restores the chip — matching is on the title text, so the pool re-pairs', () => {
    model.add(AUTH)
    message.set('How does @Auth Design handle this?')
    model.reconcile(message.read())
    expect(chips().length).toBe(1)

    // Selected through the token and deleted (or cut, or pasted over).
    message.set('How does handle this?')
    expect(model.reconcile(message.read())).toEqual([])
    expect(chips().length).toBe(0)

    // …and undone.
    message.set('How does @Auth Design handle this?')
    expect(model.reconcile(message.read())).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
    expect(chips().length).toBe(1)
    expect(chips()[0].getAttribute('data-uri')).toBe('container:9f2b')
  })

  it('a retired draft forgets everything — a title typed after a send resurrects no chip', () => {
    model.add(AUTH)
    message.retire()
    expect(model.reconcile('@Auth Design')).toEqual([])
    expect(chips().length).toBe(0)
  })

  it('re-accepting a document whose token was deleted attaches it again', () => {
    model.add(AUTH)
    message.set('nothing here')
    model.reconcile(message.read())
    expect(model.size).toBe(0)
    expect(model.add(AUTH)).toBe(true)
    expect(model.size).toBe(1)
  })
})
