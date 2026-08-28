// @ts-check
// composer-hints.test.js — the composer footer's key hints (#118 item 4).
//
// THE LIST IS A FUNCTION OF THE SPEC THE LENS PUBLISHES, and these tests hold it
// to exactly that: no arrangement, no host and no mount appears in any of them —
// a capabilities object goes in and a hint list comes out. That is the whole
// contract, and it is what stops a second mount growing a second hardcoded list.

import { describe, it, expect } from 'vitest'
import { ComposerHints } from '../src/static/shell/composer-hints.js'
import { LensCapability } from '../src/static/contract/lens-capabilities.js'

/** A published spec. Defaults to the draft the Ask panel actually mounts —
 *  everything but block minting. */
const caps = (over = {}) => Object.freeze(Object.assign({
  [LensCapability.MARKDOWN]: true,
  [LensCapability.MENTIONS]: true,
  [LensCapability.COMMANDS]: true,
  [LensCapability.BLOCKS]: false,
}, over))

/** @param {any} spec @returns {string[]} the hints as `key label` */
const shown = (spec) => ComposerHints.hintsFor(spec).map((h) => h.key + ' ' + h.label)

/** The mod key label `ComposerHints` resolves for the current test platform. */
const MOD = navigator.platform && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'

describe('ComposerHints.hintsFor — the hints a spec earns', () => {
  it('always states the composer OWN key claim — Mod+Enter sends', () => {
    expect(shown(caps({ mentions: false, commands: false })))
      .toEqual([`${MOD}+Enter send`])
  })

  it('offers `@ mention` only when the lens publishes mentions', () => {
    expect(shown(caps({ commands: false }))).toContain('@ mention')
    expect(shown(caps({ mentions: false, commands: false }))).not.toContain('@ mention')
  })

  it('offers `/ command` only when the lens publishes commands', () => {
    expect(shown(caps({ mentions: false }))).toContain('/ command')
    expect(shown(caps({ mentions: false, commands: false }))).not.toContain('/ command')
  })

  it('a fully-served draft earns all three, claim first then what it can reach', () => {
    expect(shown(caps())).toEqual([`${MOD}+Enter send`, '@ mention', '/ command'])
  })

  it('markdown and blocks earn NO hint — neither is a key you press', () => {
    expect(shown(caps({ mentions: false, commands: false, blocks: true, markdown: false })))
      .toEqual([`${MOD}+Enter send`])
  })

  it('NO LENS, NO HINTS: a footer says nothing about a composer that is not mounted', () => {
    expect(ComposerHints.hintsFor(null)).toEqual([])
  })
})

describe('ComposerHints — the row it draws', () => {
  /** @returns {HTMLElement} the structural footer, as index.html renders it */
  function mountFooter() {
    document.body.innerHTML = `
      <div id="ask-panel"><div class="ask-composer"><div class="ask-popup__footer">
        <button class="ask-popup__send">Send</button>
      </div></div></div>`
    return /** @type {HTMLElement} */ (document.querySelector('.ask-popup__footer'))
  }

  it('takes the footer LEFT EDGE — the row is inserted first, Send stays last', () => {
    const footer = mountFooter()
    new ComposerHints(footer).show(caps())
    expect(Array.from(footer.children).map((c) => c.className))
      .toEqual(['ask-popup__hints', 'ask-popup__send'])
  })

  it('draws one element per hint, the CHORD emphasised and the gloss plain', () => {
    const footer = mountFooter()
    new ComposerHints(footer).show(caps({ mentions: false, commands: false }))
    const hints = Array.from(footer.querySelectorAll('.ask-popup__hint'))
    expect(hints.map((h) => h.textContent)).toEqual([`${MOD}+Enter send`])
    expect(hints.map((h) => /** @type {HTMLElement} */ (h.querySelector('b')).textContent))
      .toEqual([`${MOD}+Enter`])
  })

  it('REDRAWS from the spec it is given — a narrower draft loses its hint', () => {
    const footer = mountFooter()
    const hints = new ComposerHints(footer)
    hints.show(caps())
    expect(footer.querySelectorAll('.ask-popup__hint').length).toBe(3)
    hints.show(caps({ mentions: false, commands: false }))
    expect(footer.querySelectorAll('.ask-popup__hint').length).toBe(1)
  })

  it('hides the row entirely when there is no lens to describe', () => {
    const footer = mountFooter()
    const hints = new ComposerHints(footer)
    hints.show(null)
    const row = /** @type {HTMLElement} */ (footer.querySelector('.ask-popup__hints'))
    expect(row.style.display).toBe('none')
    expect(row.innerHTML).toBe('')
  })

  it('is HEADLESS-SAFE: no footer, no row, and show() still answers', () => {
    const hints = new ComposerHints(null)
    expect(() => hints.show(caps())).not.toThrow()
  })
})
