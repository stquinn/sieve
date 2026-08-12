// @ts-check
// target-chips.test.js — TargetChips (#74): the footer's view of what the
// message will ACT ON. The panel-level behaviour (when it is drawn, what it
// tracks) lives in ask-panel.test.js; this pins the class's own contract — it
// draws into the existing footer, it is view-only, and it is not an attachment.

import { describe, it, expect, beforeEach } from 'vitest'
import { TargetChips } from '../src/static/shell/target-chips.js'
import { ComposerAttachments } from '../src/static/shell/composer-attachments.js'

/** The structural footer as index.html renders it (never rebuilt by the class). */
function mountFooter() {
  document.body.innerHTML = `
    <div id="ask-panel">
      <div class="ask-popup__footer">
        <span class="ask-popup__hint">Enter to send · Shift+Enter for new line</span>
        <button class="ask-popup__send">Send</button>
      </div>
    </div>`
  return /** @type {HTMLElement} */ (document.querySelector('.ask-popup__footer'))
}

const chips = () => document.querySelectorAll('.ask-target-chip')

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
    expect(order).toEqual(['ask-popup__target', 'ask-popup__chips', 'ask-popup__hint', 'ask-popup__send'])
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
    expect(target.size).toBe(0)
  })

  it('a context with no target draws nothing', () => {
    const target = new TargetChips(footer)
    target.show(/** @type {any} */ ({ docUuid: 'u-1' }))
    expect(chips().length).toBe(0)
  })
})
