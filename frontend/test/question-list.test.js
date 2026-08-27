// @ts-check
// QuestionList — the vocabulary every composer gesture mints an ai-block's
// question through. What is pinned here is the WIRE SHAPE Go decodes: the
// element encoding, the addresses spelled against the composer's own container,
// and the mandatory role stamp on every reference a gesture mints.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { QuestionList, QuestionRel } from '../src/static/renderers/question-list.js'

const DOC = '0197b2aa-1111-7888-8999-aaaabbbbcccc'
const LEAF = '0197b2aa-3333-7888-8999-aaaabbbbcccc'
const OTHER = '0197b2aa-2222-7888-8999-aaaabbbbcccc'

describe('QuestionList — what a gesture mints', () => {
  it('refuses to exist without the container its addresses are spelled against', () => {
    expect(() => new QuestionList('')).toThrow()
  })

  it('the whole-document target is the container itself, with no leaf', () => {
    expect(new QuestionList(DOC).about('doc').elements).toEqual([
      { kind: 'reference', attrs: { uri: 'sieve://' + DOC, rel: 'target' } },
    ])
  })

  it('a block target is a leaf of this container', () => {
    expect(new QuestionList(DOC).about(LEAF).elements).toEqual([
      { kind: 'reference', attrs: { uri: 'sieve://' + DOC + '/' + LEAF, rel: 'target' } },
    ])
  })

  it('a multi-block selection mints one target per block, in order', () => {
    const uris = new QuestionList(DOC).about('a, b ,c').elements.map((el) => el.attrs.uri)
    expect(uris).toEqual(['sieve://' + DOC + '/a', 'sieve://' + DOC + '/b', 'sieve://' + DOC + '/c'])
  })

  it('no target token mints no target — the detached class is an absence', () => {
    expect(new QuestionList(DOC).about('').elements).toEqual([])
    expect(new QuestionList(DOC).about(null).elements).toEqual([])
  })

  // EVERY reference a gesture mints declares its role; the address rule behind it
  // is for hand-authored fences only.
  it('every minted reference carries a rel', () => {
    const list = new QuestionList(DOC)
      .about('doc')
      .ask('why?')
      .attach([{ uri: 'sieve://other', title: 'Other' }])
      .elements
    const rels = list.filter((el) => el.kind === 'reference').map((el) => el.attrs.rel)
    expect(rels).toEqual([QuestionRel.TARGET, QuestionRel.ATTACH])
  })

  it('the authored text is one prose element; blank text is none', () => {
    expect(new QuestionList(DOC).ask('why?').elements).toEqual([
      { kind: 'prose', attrs: { content: 'why?' } },
    ])
    expect(new QuestionList(DOC).ask('   ').elements).toEqual([])
    expect(new QuestionList(DOC).ask(undefined).elements).toEqual([])
  })

  // An attachment's title is the FACE — what was taken from the target — so it
  // rides under `cache`, never at the root, which is the pointing's own space.
  it('an attachment carries its address at root and its title as the face', () => {
    expect(new QuestionList(DOC).attach([{ uri: 'sieve://other', title: 'Other' }]).elements).toEqual([
      { kind: 'reference', attrs: { uri: 'sieve://other', rel: 'attach', cache: { title: 'Other' } } },
    ])
  })

  it('an attachment with no address is not an attachment; a title-less one is bare', () => {
    expect(new QuestionList(DOC).attach([{ uri: '  ' }, { uri: 'sieve://x' }]).elements).toEqual([
      { kind: 'reference', attrs: { uri: 'sieve://x', rel: 'attach' } },
    ])
  })

  it('nothing mints an element id — Go mints one in place at decode', () => {
    const list = new QuestionList(DOC).about('doc').ask('q').attach([{ uri: 'sieve://x' }]).elements
    for (const el of list) expect(el.attrs).not.toHaveProperty('id')
  })

  it('gesture order is list order: about, then asked, then attached', () => {
    const kinds = new QuestionList(DOC)
      .about('doc').ask('q').attach([{ uri: 'sieve://x' }]).elements.map((el) => el.kind)
    expect(kinds).toEqual(['reference', 'prose', 'reference'])
  })

  it('the elements it hands out are a copy — a later gesture cannot rewrite a sent list', () => {
    const list = new QuestionList(DOC)
    const sent = list.about('doc').elements
    list.ask('later')
    expect(sent).toHaveLength(1)
  })
})

describe('QuestionList.text — the readable line of a question', () => {
  it('a list reads as its prose, in order', () => {
    const list = new QuestionList(DOC).about('doc').ask('why?').elements
    expect(QuestionList.text(list)).toBe('why?')
  })

  it('several prose elements are separated as paragraphs', () => {
    const list = new QuestionList(DOC).ask('first').ask('second').elements
    expect(QuestionList.text(list)).toBe('first\n\nsecond')
  })

  it('a reference-only question has no text', () => {
    expect(QuestionList.text(new QuestionList(DOC).about('doc').elements)).toBe('')
  })

  // A standalone command's popup block is a detached answer, not a question in a
  // document, and carries the plain text it was asked with.
  it('a plain string reads as itself, and anything else has no text', () => {
    expect(QuestionList.text('just words')).toBe('just words')
    expect(QuestionList.text(null)).toBe('')
    expect(QuestionList.text({})).toBe('')
  })
})

// ── The shared wire fixture ──────────────────────────────────────────────────
// The composer and the fold that reads it live in two suites with no common
// runtime, so the contract between them is a FILE both read:
// sieve/block/processors/testdata/composer-wire-payload.json.
//
// Here each case's `gesture` is replayed through QuestionList and its output
// held to that case's `attrs.question`. In Go, ai_block_composer_wire_test.go
// folds the SAME `attrs` and asserts it reaches the prompt slots. Neither side
// can restate the shape alone: changing the composer fails this suite until the
// file is updated, and updating the file puts the new spelling straight in front
// of the fold.

/** @typedef {{ name: string, gesture: { about?: string, ask?: string, attach?: Array<{uri: string, title?: string}> }, attrs: { question: any[] } }} WireCase */

// vitest's root is frontend/ (vitest.config.js), which process.cwd() matches at
// test time; import.meta.url is unreliable here — the same resolution
// contract-purity.test.js and lens-isolation.test.js use.
const WIRE_FIXTURE = path.resolve(process.cwd(), '../sieve/block/processors/testdata/composer-wire-payload.json')
const WIRE = JSON.parse(readFileSync(WIRE_FIXTURE, 'utf8'))

describe('QuestionList — the shared wire fixture', () => {
  it('names the container the composer mints against', () => {
    expect(WIRE.container).toBe(DOC)
  })

  it('has cases', () => {
    expect(WIRE.cases.length).toBeGreaterThan(0)
  })

  for (const wireCase of /** @type {WireCase[]} */ (WIRE.cases)) {
    it(`${wireCase.name}: the gesture mints exactly what Go folds`, () => {
      const g = wireCase.gesture
      const minted = new QuestionList(WIRE.container)
        .about(g.about)
        .ask(g.ask)
        .attach(g.attach)
        .elements
      expect(minted).toEqual(wireCase.attrs.question)
    })
  }
})

// ── The fold: reading a question back ────────────────────────────────────────
// The mirror of Go's AIBlockProcessor.foldQuestion. Both sides classify the same
// element into the same slot, so what the prompt was built from is what the
// block draws. The cases here are the ones where the two could drift: `rel`
// against the address, the addresses the grammar rejects, and the pin.

/** @param {string} uri @param {string} [rel] @param {string} [title] */
function ref(uri, rel, title) {
  /** @type {Record<string, any>} */ const attrs = { uri: uri }
  if (rel) attrs.rel = rel
  if (title) attrs.cache = { title: title }
  return { kind: 'reference', attrs: attrs }
}

/** @param {string} content */
const prose = (content) => ({ kind: 'prose', attrs: { content: content } })

/** @param {any} q @param {string} [container] */
const slots = (q, container) => QuestionList.fold(q, container === undefined ? DOC : container)

describe('QuestionList — the fold', () => {
  it('every non-reference element is the body, whatever its kind', () => {
    const q = [prose('why?'), { kind: 'code', attrs: { source: 'x' } }, { kind: 'log', attrs: { source: 'y' } }]
    expect(slots(q).body).toEqual(q)
    expect(slots(q).targets).toEqual([])
    expect(slots(q).attachments).toEqual([])
  })

  it('a declared role decides outright, against the address', () => {
    // rel:attach on the container the question lives in — the one thing an
    // address cannot say on its own.
    expect(slots([ref('sieve://' + DOC, 'attach')]).attachments.length).toBe(1)
    // rel:target on another container — first-class material, rendered in place.
    expect(slots([ref('sieve://' + OTHER, 'target')]).targets.length).toBe(1)
  })

  it('an undeclared or unrecognised role falls to the address', () => {
    for (const rel of [undefined, 'quote']) {
      expect(slots([ref('sieve://' + DOC, rel)]).targets.length).toBe(1)
      expect(slots([ref('sieve://' + DOC + '/' + LEAF, rel)]).targets.length).toBe(1)
      expect(slots([ref('sieve://' + OTHER, rel)]).attachments.length).toBe(1)
      expect(slots([ref('https://example.com/x', rel)]).attachments.length).toBe(1)
    }
  })

  it('the local handle is the whole-document token, or the leaf', () => {
    expect(QuestionList.localToken(ref('sieve://' + DOC), DOC)).toBe('doc')
    expect(QuestionList.localToken(ref('sieve://' + DOC + '/' + LEAF), DOC)).toBe(LEAF)
    expect(QuestionList.localToken(ref('sieve://' + OTHER + '/' + LEAF), DOC)).toBeNull()
  })

  it('case never distinguishes two coordinates', () => {
    expect(QuestionList.localToken(ref('sieve://' + DOC.toUpperCase()), DOC)).toBe('doc')
  })

  it('a PINNED address names a frozen container and is never the live one', () => {
    expect(QuestionList.localToken(ref('sieve://' + DOC + '?version=3'), DOC)).toBeNull()
    expect(QuestionList.localToken(ref('sieve://' + DOC + '?version=0'), DOC)).toBeNull()
    expect(QuestionList.localToken(ref('sieve://' + DOC + '?other=3'), DOC)).toBeNull()
  })

  it('an address the grammar rejects has no local handle', () => {
    const rejected = ['', 'sieve://not-a-uuid', 'sieve://' + DOC + '/a/b', 'sieve://' + DOC + '/',
      'sieve://' + DOC + '#frag', 'sieve://' + DOC + '?', 'container:' + DOC, '/' + LEAF]
    for (const uri of rejected) expect(QuestionList.localToken(ref(uri), DOC)).toBeNull()
  })

  it('mounted nowhere, everything addressed is elsewhere', () => {
    expect(QuestionList.localToken(ref('sieve://' + DOC), '')).toBeNull()
  })

  it('a scalar question is the one prose element it always was', () => {
    expect(QuestionList.elementsOf('why?')).toEqual([prose('why?')])
    expect(QuestionList.elementsOf('   ')).toEqual([])
    expect(QuestionList.elementsOf(null)).toEqual([])
    expect(QuestionList.elementsOf([null, 7, { attrs: {} }, prose('a')])).toEqual([prose('a')])
  })

  it("a folded slot holds the caller's own elements, so list order is recoverable", () => {
    const list = [ref('sieve://' + OTHER, 'attach'), prose('why?')]
    const folded = QuestionList.fold(list, DOC)
    expect(folded.attachments[0]).toBe(list[0])
    expect(folded.body[0]).toBe(list[1])
  })
})
