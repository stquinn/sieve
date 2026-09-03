// @ts-check
// spell-control.test.js — the workspace's spelling verbs and its share of the
// text-service lifecycle. NEW FILE because SpellControl is a new unit, and the
// shell's services are tested one file each (command-service, mention-service,
// invalidation-service).
//
// The whole class is a sender plus one boolean, so the assertions are about
// exactly that: which frame went out, and what the button would read afterwards.
import { describe, it, expect, beforeEach } from 'vitest'
import { SpellControl } from '../src/static/shell/spell-control.js'
import { Feature, WorkspaceFrame } from '../src/static/generated/protocol.js'

/** A stand-in for the wire owner: records the frames put on it. */
function fakePlane() {
  return {
    sent: /** @type {any[]} */ ([]),
    /** @param {Record<string, any>} frame */
    send(frame) { this.sent.push(frame) },
  }
}

describe('SpellControl', () => {
  /** @type {ReturnType<typeof fakePlane>} */ let plane

  beforeEach(() => { plane = fakePlane() })

  it('starts from the setting the page was served, and ON when it was served none', () => {
    expect(new SpellControl(/** @type {any} */ (plane), true).enabled).toBe(true)
    expect(new SpellControl(/** @type {any} */ (plane), false).enabled).toBe(false)
    expect(new SpellControl(/** @type {any} */ (plane), /** @type {any} */ (undefined)).enabled).toBe(true)
  })

  // The toggle is the SHARED lifecycle frame naming spelling, not a spelling
  // verb: it carries the feature word, the state it was put into, and the empty
  // parameter bag every feature's frame has room for.
  it('toggle sends the feature-control frame for the state it flipped INTO, and reads back as that state at once', () => {
    const spell = new SpellControl(/** @type {any} */ (plane), true)
    expect(spell.toggle()).toBe(false)
    expect(spell.enabled).toBe(false)
    expect(spell.toggle()).toBe(true)
    expect(plane.sent).toEqual([
      { type: WorkspaceFrame.FEATURE_CONTROL, feature: Feature.SPELL_CHECK, enabled: false, parameters: {} },
      { type: WorkspaceFrame.FEATURE_CONTROL, feature: Feature.SPELL_CHECK, enabled: true, parameters: {} },
    ])
  })

  it('ignore and learn send the word as it was written — the server folds it', () => {
    const spell = new SpellControl(/** @type {any} */ (plane), true)
    spell.ignore('Zzblorp’s')
    spell.learn('Zzblorp’s')
    expect(plane.sent).toEqual([
      { type: 'spell-ignore', word: 'Zzblorp’s' },
      { type: 'spell-learn', word: 'Zzblorp’s' },
    ])
  })

  it('an empty word is not a verb — nothing goes on the wire', () => {
    const spell = new SpellControl(/** @type {any} */ (plane), true)
    spell.ignore('')
    spell.learn('')
    expect(plane.sent).toEqual([])
  })
})
