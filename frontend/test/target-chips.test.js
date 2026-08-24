// @ts-check
// target-chips.test.js — TargetChips (#74, #82): the footer's view of what the
// message will ACT ON. The panel-level behaviour (when it is drawn, what it
// tracks) lives in ask-panel.test.js; this pins the class's own contract — it
// draws into the existing footer, it is view-only, it is not an attachment, and
// a SELECTION gets a chip per block labelled from the injected block cache.

import { describe, it, expect, beforeEach } from 'vitest'
import { TargetChips } from '../src/static/shell/target-chips.js'
import { ComposerAttachments } from '../src/static/shell/composer-attachments.js'

/** The structural footer as index.html renders it (never rebuilt by the class). */
function mountFooter() {
  document.body.innerHTML = `
    <div id="ask-panel">
      <div class="ask-popup__footer">
        <button class="ask-popup__send">Send</button>
      </div>
    </div>`
  return /** @type {HTMLElement} */ (document.querySelector('.ask-popup__footer'))
}

/**
 * A stub container: `blocks` maps id → {kind, attrs}. No wire, no globals — the
 * shape a ContainerProvider's getBlock answers with.
 * @param {Record<string, {kind: string, attrs?: Record<string, any>}>} blocks
 */
function container(blocks) {
  return { getBlock: (id) => blocks[id] || null }
}

/** @param {string} kind @param {Record<string, any>} [attrs] */
const held = (kind, attrs) => ({ kind, attrs: attrs || {} })

/** A selection context spanning `ids`. */
const selecting = (ids, label = '“retry policy”') => /** @type {any} */ ({
  target: { kind: 'selection', ref: ids.join(','), label: label },
  blockIds: ids,
})

const chips = () => Array.from(document.querySelectorAll('.ask-target-chip'))
/** The chips' LABELS, without the leading kind glyph. */
const labels = () => chips().map((c) => {
  const label = c.querySelector('.ask-target-chip__label')
  return label ? label.textContent : ''
})

describe('TargetChips', () => {
  /** @type {HTMLElement} */ let footer
  beforeEach(() => { footer = mountFooter() })

  it('draws one chip for the context target and nothing for no context', () => {
    const target = new TargetChips(footer)
    expect(chips().length).toBe(0)

    target.show(/** @type {any} */ ({ target: { kind: 'block', ref: 'co-1', label: 'Code Block' } }))
    expect(chips().length).toBe(1)
    expect(chips()[0].textContent).toContain('Code Block')
    expect(target.size).toBe(1)

    target.show(null)
    expect(chips().length).toBe(0)
    expect(target.size).toBe(0)
  })

  it('is VIEW-ONLY: no ✕, no button, nothing to click', () => {
    const target = new TargetChips(footer)
    target.show(/** @type {any} */ ({ target: { label: 'Document' } }))
    const chip = chips()[0]
    expect(chip.querySelector('button')).toBe(null)
    expect(chip.querySelector('.ask-chip__remove')).toBe(null)
    // And it is not an attachment chip by any selector that counts them.
    expect(document.querySelectorAll('.ask-chip').length).toBe(0)
  })

  it('lands LEFT of the attachment chips and leaves Send last', () => {
    new TargetChips(footer)
    new ComposerAttachments(footer)
    const order = Array.from(footer.children).map((c) => c.className.split(' ')[0])
    expect(order).toEqual(['ask-popup__target', 'ask-popup__chips', 'ask-popup__send'])
  })

  it('escapes a label — a selection snippet is user text', () => {
    const target = new TargetChips(footer)
    target.show(/** @type {any} */ ({ target: { label: '“<img src=x onerror=1>”' } }))
    const label = /** @type {HTMLElement} */ (document.querySelector('.ask-target-chip__label'))
    expect(label.querySelector('img')).toBe(null)
    expect(label.textContent).toBe('“<img src=x onerror=1>”')
  })

  it('is headless-safe: no footer, no throw, every verb still callable', () => {
    const target = new TargetChips(null)
    expect(() => target.show(/** @type {any} */ ({ target: { label: 'Document' } }))).not.toThrow()
    expect(target.size).toBe(1)   // the model still answers; there is just nothing to draw into
    expect(() => target.show(null)).not.toThrow()
    expect(() => target.containerChanged({ blockIds: ['b1'] })).not.toThrow()
    expect(target.size).toBe(0)
  })

  it('a context with no target draws nothing', () => {
    const target = new TargetChips(footer)
    target.show(/** @type {any} */ ({ docUuid: 'u-1' }))
    expect(chips().length).toBe(0)
  })
})

// ── The per-block row (#82) ──────────────────────────────────────────────────
//
// A range selection spans blocks the user picked out, so each earns a chip. The
// LABELS are derived here, at paint time, from the injected block cache —
// nothing about them travels on the SelectionContext, which stays ids-only.
describe('TargetChips — a chip per block of a SELECTION', () => {
  /** @type {HTMLElement} */ let footer
  beforeEach(() => { footer = mountFooter() })

  it('labels each kind from its own payload key', () => {
    const target = new TargetChips(footer, container({
      p1: held('prose', { content: '## The migration plan is the interesting half of this' }),
      c1: held('code', { language: 'go', source: 'func main() {}' }),
      d1: held('diagram', { diagramType: 'mermaid', source: 'graph TD' }),
    }))
    target.show(selecting(['p1', 'c1', 'd1']))

    expect(labels()).toEqual([
      '“retry policy”', 'The migration plan is the…', 'go', 'mermaid',
    ])
  })

  it('falls back to the KIND NAME when the payload carries no hint', () => {
    const target = new TargetChips(footer, container({
      l1: held('log', { source: '12:00 boot' }),
      c1: held('code', { source: 'x = 1' }),          // no language yet
      w1: held('web-clip', { title: '' }),
    }))
    target.show(selecting(['l1', 'c1', 'w1']))
    expect(labels().slice(1)).toEqual(['log', 'code', 'web clip'])
  })

  it('a CONTAINER MISS still draws a chip: the generic noun, never nothing', () => {
    // The container holds b1 with no hint-bearing attr; it has never heard of b2.
    const target = new TargetChips(footer, container({ b1: held('ai-block') }))
    target.show(selecting(['b1', 'b2']))
    expect(labels().slice(1)).toEqual(['ai block', 'block'])
  })

  it('with NO container injected the chips stand, unlabelled rather than absent', () => {
    const target = new TargetChips(footer, null)
    target.show(selecting(['b1', 'b2']))
    expect(labels()).toEqual(['“retry policy”', 'block', 'block'])
  })

  it('is SELECTION-ONLY: a document target keeps the single chip', () => {
    const target = new TargetChips(footer, container({ p1: held('prose', { content: 'Hello' }) }))
    // The caret's block rides on blockIds for a document target too — it is the
    // SPAN, not the target's extent, so a chip per block would misdescribe the send.
    target.show(/** @type {any} */ ({ target: { kind: 'document', ref: 'doc', label: 'Document' }, blockIds: ['p1'] }))
    expect(labels()).toEqual(['Document'])

    target.show(/** @type {any} */ ({ target: { kind: 'block', ref: 'p1', label: 'Paragraph' }, blockIds: ['p1'] }))
    expect(labels()).toEqual(['Paragraph'])
  })

  it('caps the row at four and counts the rest in ONE inert chip', () => {
    const blocks = {}
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']
    ids.forEach((id, i) => { blocks[id] = held('code', { language: 'lang' + i }) })
    const target = new TargetChips(footer, container(blocks))
    target.show(selecting(ids))

    expect(labels()).toEqual(['“retry policy”', 'lang0', 'lang1', 'lang2', 'lang3', '+2 more'])
    expect(target.size).toBe(6)
    const more = /** @type {HTMLElement} */ (document.querySelector('.ask-target-chip--more'))
    expect(more.querySelector('button')).toBe(null)
    expect(more.getAttribute('title')).toBe('lang4, lang5')   // what it stands for
  })

  it('names only a readable few in the overflow tooltip — select-all must not build a mile of it', () => {
    const ids = Array.from({ length: 40 }, (_, i) => 'b' + i)
    const seen = []
    const target = new TargetChips(footer, {
      getBlock: (id) => { seen.push(id); return held('code', { language: id }) },
    })
    target.show(selecting(ids))

    const more = /** @type {HTMLElement} */ (document.querySelector('.ask-target-chip--more'))
    expect(more.textContent).toBe('+36 more')
    expect(more.getAttribute('title')).toBe('b4, b5, b6, b7, …')
    expect(seen.length).toBe(8)     // the four drawn, the four named — never all forty
  })

  it('repaints the chip whose block changed, and ONLY for a block it draws', () => {
    let language = 'go'
    const target = new TargetChips(footer, { getBlock: () => held('code', { language }) })
    target.show(selecting(['b1']))
    expect(labels()[1]).toBe('go')

    language = 'rust'
    target.containerChanged({ blockIds: ['other'] })  // not in the selection: no repaint
    expect(labels()[1]).toBe('go')

    target.containerChanged({ blockIds: ['b1'] })
    expect(labels()[1]).toBe('rust')
  })

  it('re-points at another container when the active mount changes', () => {
    const target = new TargetChips(footer, container({ b1: held('code', { language: 'go' }) }))
    target.show(selecting(['b1']))
    expect(labels()[1]).toBe('go')

    target.setSource(container({ b1: held('code', { language: 'rust' }) }))
    expect(labels()[1]).toBe('rust')
  })

  it('escapes a derived label — a prose hint is user text', () => {
    const target = new TargetChips(footer, container({
      p1: held('prose', { content: '<img src=x onerror=1>' }),
    }))
    target.show(selecting(['p1']))
    const label = /** @type {HTMLElement} */ (chips()[1].querySelector('.ask-target-chip__label'))
    expect(label.querySelector('img')).toBe(null)
    expect(label.textContent).toBe('<img src=x onerror=1>')
  })
})
