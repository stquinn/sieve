// @ts-check
// outline-lens.test.js — the pathfinder lens, mounted against a FakeHost
// (issue #96 P3).
//
// Everything here runs on a ContainerModel, a ProviderAdapter and a plain
// element: no ProseMirror, no shell, no workspace, no socket. The frames are
// the recorded fixtures the model's own suites replay, so the lens follows real
// wire traffic — including the two mutation echoes P2 added (remove-block,
// order-changed), which are exactly the folds an outline cannot fake.

import { describe, it, expect } from 'vitest'
import { FakeHost } from './helpers/fake-host.js'
import { OutlineLens } from '../src/static/lens/outline/outline-lens.js'
import { Lens } from '../src/static/lens/lens.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

import seq2 from './fixtures/container-frames/seq-2-paste-inserts.json'
import seq3 from './fixtures/container-frames/seq-3-transform-and-reseed.json'

/** The painted cards, as [kind, excerpt] pairs in document order.
 *  @param {HTMLElement} element @returns {string[][]} */
function cards(element) {
  return [...element.querySelectorAll('.sieve-outline__card')].map((card) => [
    /** @type {HTMLElement} */ (card).dataset.blockKind || '',
    card.querySelector('.sieve-outline__excerpt')?.textContent || '',
  ])
}

/** @param {HTMLElement} element @returns {string[]} */
function ids(element) {
  return [...element.querySelectorAll('.sieve-outline__card')]
    .map((card) => /** @type {HTMLElement} */ (card).dataset.blockId || '')
}

/** @param {HTMLElement} element @param {string} id @returns {HTMLElement} */
function card(element, id) {
  return /** @type {HTMLElement} */ (element.querySelector(`[data-block-id="${id}"]`))
}

/** A host with seq-2's load answer applied and the lens mounted, ready for the
 *  remaining frames — the ordinary case: a container that already exists when a
 *  lens arrives.
 *  @returns {{host: FakeHost, lens: OutlineLens, element: HTMLElement, rest: any[]}} */
function mountedOnSeq2() {
  const host = new FakeHost(seq2.uuid)
  host.play(seq2.steps[0])
  const lens = new OutlineLens(host.provider)
  return { host, lens, element: host.mount(lens), rest: seq2.steps.slice(1) }
}

describe('Lens base contract', () => {
  it('is abstract', () => {
    const host = new FakeHost('doc-1')
    expect(() => new Lens(host.provider)).toThrow(ContractViolation)
  })

  it('demands a provider', () => {
    expect(() => new OutlineLens(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new OutlineLens(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('refuses a subclass with no paint', () => {
    class Bare extends Lens {}
    const host = new FakeHost('doc-1')
    expect(() => new Bare(host.provider)).toThrow(ContractViolation)
  })

  it('refuses a second mount and a listener that cannot listen', () => {
    const host = new FakeHost('doc-1')
    const lens = new OutlineLens(host.provider)
    host.mount(lens)
    expect(() => lens.mount(document.createElement('div'))).toThrow(ContractViolation)
    expect(() => lens.setSelectionListener(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })
})

describe('OutlineLens bootstrap paint', () => {
  it('paints the whole container from the subscribe cue', () => {
    const { element } = mountedOnSeq2()
    expect(cards(element)).toEqual([
      ['prose', 'before'],
      ['prose', 'after'],
    ])
  })

  it('paints an empty container, then follows the load answer', () => {
    const host = new FakeHost(seq2.uuid)
    const lens = new OutlineLens(host.provider)
    const element = host.mount(lens)
    expect(cards(element)).toEqual([])

    host.play(seq2.steps[0])
    expect(ids(element)).toEqual(['p1', 'p2'])
  })

  it('shows the block kind and a flattened, truncated excerpt', () => {
    const host = new FakeHost('doc-x')
    host.play({
      load: {
        uuid: 'doc-x',
        blocks: [
          { id: 'c1', kind: 'code', attrs: { source: 'line one\n  line two' } },
          { id: 'l1', kind: 'log', attrs: { source: 'x'.repeat(200) } },
          { id: 'o1', kind: 'opaque', attrs: { blob: 42 } },
        ],
      },
    })
    const lens = new OutlineLens(host.provider)
    const element = host.mount(lens)

    expect(cards(element)).toEqual([
      ['code', 'line one line two'],
      ['log', 'x'.repeat(119) + '…'],
      ['opaque', ''],
    ])
  })

  it('escapes block content rather than rendering it', () => {
    const host = new FakeHost('doc-x')
    host.play({ load: { uuid: 'doc-x', blocks: [{ id: 'p1', kind: 'prose', attrs: { content: '<img src=x onerror=boom>' } }] } })
    const lens = new OutlineLens(host.provider)
    const element = host.mount(lens)

    expect(element.querySelector('img')).toBeNull()
    expect(card(element, 'p1').textContent).toContain('<img src=x onerror=boom>')
  })
})

describe('OutlineLens follows the container', () => {
  it('follows inserts, in-place attr changes, removals and reorders', () => {
    const { host, element, rest } = mountedOnSeq2()

    // insert-block at a caret-derived index
    host.play(rest[0])
    expect(ids(element)).toEqual(['p1', 'img-1', 'p2'])

    // insert-block with index -1 (Go's append), then index 0
    host.play(rest[1])
    host.play(rest[2])
    expect(ids(element)).toEqual(['unk-1', 'p1', 'img-1', 'p2', 'clip-1'])
    // a frame with no kind is a WYSIWYG block, and the model's default is code
    expect(card(element, 'unk-1').dataset.blockKind).toBe('code')

    // block-attrs-updated: the card is rewritten in place, not replaced
    const imgCard = card(element, 'img-1')
    host.play(rest[3])
    expect(card(element, 'img-1')).toBe(imgCard)
    expect(ids(element)).toEqual(['unk-1', 'p1', 'img-1', 'p2', 'clip-1'])

    // remove-block: the echo P2 added — the card leaves
    host.play(rest[4])
    expect(ids(element)).toEqual(['unk-1', 'p1', 'img-1', 'clip-1'])

    // order-changed: the other P2 echo — cards move, elements survive
    host.play(rest[5])
    expect(ids(element)).toEqual(['clip-1', 'unk-1', 'img-1', 'p1'])
    expect(card(element, 'img-1')).toBe(imgCard)

    expect(cards(element)).toEqual([
      ['web-clip', 'https://x.test'],
      ['code', '?'],
      ['smart-image', '/ui/assets/doc-seq-2/a.png'],
      ['prose', 'before'],
    ])
  })

  it('follows a transform and a whole-list reseed', () => {
    const host = new FakeHost(seq3.uuid)
    host.play(seq3.steps[0])
    const lens = new OutlineLens(host.provider)
    const element = host.mount(lens)
    expect(ids(element)).toEqual(['p1', 'c1', 'l1'])

    // insert, then replace-block: a transform mints a fresh identity in place
    host.play(seq3.steps[1])
    host.play(seq3.steps[2])
    expect(ids(element)).toEqual(['p1', 'd1', 'r1', 'l1'])
    expect(card(element, 'd1').dataset.blockKind).toBe('diagram')

    // the reseed load answer retires a block nothing named
    host.play(seq3.steps[3])
    host.play(seq3.steps[4])
    expect(ids(element)).toEqual(['p1', 'l1', 'd1'])
  })
})

describe('OutlineLens presence', () => {
  it('advertises a best-attempt block context on click', () => {
    const { host, element } = mountedOnSeq2()
    card(element, 'p2').click()

    expect(host.lastAdvert).toEqual({
      docUuid: 'doc-seq-2',
      selectionType: 'block',
      blockId: 'p2',
      blockIds: ['p2'],
      blockKind: 'prose',
    })
    expect(Object.isFrozen(host.lastAdvert)).toBe(true)
  })

  it('marks the clicked card and keeps the mark across a repaint', () => {
    const { host, element, rest } = mountedOnSeq2()
    card(element, 'p1').click()
    expect(card(element, 'p1').classList.contains('is-selected')).toBe(true)

    rest.forEach((step) => host.play(step))
    expect(card(element, 'p1').classList.contains('is-selected')).toBe(true)
    expect(host.adverts).toHaveLength(1)
  })

  it('says nothing when no listener is registered, or when the click misses a card', () => {
    const host = new FakeHost(seq2.uuid)
    host.play(seq2.steps[0])
    const lens = new OutlineLens(host.provider)
    const element = document.createElement('div')
    lens.mount(element) // deliberately no setSelectionListener

    expect(() => card(element, 'p1').click()).not.toThrow()
    expect(host.adverts).toEqual([])

    lens.setSelectionListener(host)
    const gap = /** @type {HTMLElement} */ (element.querySelector('.sieve-outline'))
    gap.click()
    expect(host.adverts).toEqual([])
  })
})

describe('OutlineLens unmount', () => {
  it('unsubscribes, empties the host and stays quiet', () => {
    const { host, lens, element, rest } = mountedOnSeq2()
    /** @type {any[]} */
    const witness = []
    host.subscribe({ onChanged: (change) => witness.push(change) })
    witness.length = 0 // drop the witness's own bootstrap cue

    lens.unmount()
    expect(lens.isMounted).toBe(false)
    expect(element.innerHTML).toBe('')

    rest.forEach((step) => host.play(step))
    expect(witness.length).toBe(rest.length) // the frames really were folded
    expect(element.innerHTML).toBe('')
  })

  it('remounts from the container state as it stands', () => {
    const { host, lens, rest } = mountedOnSeq2()
    lens.unmount()
    rest.forEach((step) => host.play(step))

    const element = host.mount(lens)
    expect(ids(element)).toEqual(['clip-1', 'unk-1', 'img-1', 'p1'])
  })
})
