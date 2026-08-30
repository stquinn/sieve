// @ts-check
// command-verb-decoration.test.js — the `/verb` mark inside a draft (#126).
//
// The rule is POSITIONAL, so it is exercised against REAL ProseMirror documents:
// what makes a token a verb is that it opens the message, and "opens" is a fact
// about the document — an empty paragraph above it is spacing, a code block is a
// literal, and the second paragraph is not the head however it starts.
//
// THE VERB IS PUSHED. The surface never asks a registry what exists; it draws the
// one name its host says the draft resolves to, so a null verb marks nothing
// without any mount-shaped gate.

import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import {
  CommandVerbDecorations, COMMAND_VERB_CLASS,
} from '../src/static/lens/document-editor/surfaces/command-verb-decoration.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', ['code', 0]] },
    hardBreak: { group: 'inline', inline: true, selectable: false, toDOM: () => ['br'] },
    text: { group: 'inline' },
  },
  marks: {
    code: { toDOM: () => ['code', 0] },
    em: { toDOM: () => ['em', 0] },
  },
})

const n = schema.nodes
const m = schema.marks
/** @param {string} s @param {any[]} [marks] */
const t = (s, marks) => schema.text(s, marks)
/** @param {...any} content */
const p = (...content) => n.paragraph.create(null, content)
/** @param {...any} blocks */
const doc = (...blocks) => n.doc.create(null, blocks)

describe('CommandVerbDecorations.rangeOf — where the verb is', () => {
  it('marks the token the message OPENS with, at the positions it occupies', () => {
    const d = doc(p(t('/btw what is X')))
    const range = CommandVerbDecorations.rangeOf(d, 'btw')
    expect(range).toEqual({ from: 1, to: 5 })
    expect(d.textBetween(range.from, range.to)).toBe('/btw')
  })

  it('marks a verb that is the whole message', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('/btw'))), 'btw')).toEqual({ from: 1, to: 5 })
  })

  it('is case-insensitive, as the registry that resolved it is', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('/BTW x'))), 'btw')).toEqual({ from: 1, to: 5 })
  })

  it('MARKS ONLY AT POSITION 0: a verb mid-line is text', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('ask /btw about it'))), 'btw')).toBeNull()
  })

  it('THE TOKEN IS A WHOLE WORD: /btwx is a path, not the verb', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('/btwx what'))), 'btw')).toBeNull()
  })

  it('SKIPS BLOCKS THAT SAY NOTHING, exactly as the harvest does', () => {
    const d = doc(p(), p(t('   ')), p(t('/btw what is X')))
    const range = CommandVerbDecorations.rangeOf(d, 'btw')
    expect(d.textBetween(range.from, range.to)).toBe('/btw')
  })

  it('does not reach past the head: a verb in the SECOND block is not the opening', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('what about this')), p(t('/btw later'))), 'btw'))
      .toBeNull()
  })

  it('a code block cannot open a message with a verb — it is a literal', () => {
    expect(CommandVerbDecorations.rangeOf(doc(n.codeBlock.create(null, t('/btw'))), 'btw')).toBeNull()
  })

  it('nor can a run carrying the `code` mark', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('/btw', [m.code.create()]))), 'btw')).toBeNull()
  })

  it('an ordinary mark does NOT make it a literal — emphasis is still prose', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('/btw x', [m.em.create()]))), 'btw'))
      .toEqual({ from: 1, to: 5 })
  })

  it('INERT WITHOUT A VERB: the mount that resolves none marks nothing', () => {
    const d = doc(p(t('/btw what is X')))
    expect(CommandVerbDecorations.rangeOf(d, /** @type {any} */ (null))).toBeNull()
    expect(CommandVerbDecorations.rangeOf(d, '')).toBeNull()
    expect(CommandVerbDecorations.rangeOf(d, '   ')).toBeNull()
  })

  it('a verb the draft does not open with yields nothing', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p(t('/btw x'))), 'uuid')).toBeNull()
  })

  it('an empty document has no head at all', () => {
    expect(CommandVerbDecorations.rangeOf(doc(p()), 'btw')).toBeNull()
  })
})

// ── The plugin around the rule ───────────────────────────────────────────────
// A recording vendor bag, as mention-decoration.test.js uses: enough of
// Plugin/PluginKey/Decoration to run the plugin's own `decorations` prop.

function vendor() {
  return {
    T: {
      Extension: { create: (/** @type {any} */ cfg) => cfg },
      Plugin: function (/** @type {any} */ cfg) { Object.assign(this, cfg) },
      PluginKey: function (/** @type {any} */ name) {
        this.name = name
        /** @type {any} */ this.state = { verb: '' }
        this.getState = () => this.state
      },
      Decoration: {
        inline: (/** @type {number} */ from, /** @type {number} */ to, /** @type {any} */ attrs) =>
          ({ from, to, attrs }),
      },
      DecorationSet: {
        empty: 'EMPTY',
        create: (/** @type {any} */ d, /** @type {any[]} */ decos) => decos,
      },
    },
  }
}

/** The plugin's `decorations` prop, over a doc and a verb state. */
function decorationsOf(verbs, d, verb) {
  const plugin = /** @type {any} */ (verbs.extension).addProseMirrorPlugins()[0]
  plugin.key.state = { verb }
  return plugin.props.decorations({ doc: d })
}

describe('CommandVerbDecorations — the plugin', () => {
  it('turns the range into an INLINE decoration carrying the mark class', () => {
    const verbs = new CommandVerbDecorations(vendor().T)
    expect(decorationsOf(verbs, doc(p(t('/btw what is X'))), 'btw'))
      .toEqual([{ from: 1, to: 5, attrs: { class: COMMAND_VERB_CLASS } }])
  })

  it('DRAWS NOTHING with no verb — every mount that resolves none, without a gate', () => {
    const verbs = new CommandVerbDecorations(vendor().T)
    expect(decorationsOf(verbs, doc(p(t('/btw what is X'))), '')).toBe('EMPTY')
  })

  it('draws nothing when the verb names a token the draft does not open with', () => {
    const verbs = new CommandVerbDecorations(vendor().T)
    expect(decorationsOf(verbs, doc(p(t('ask /btw'))), 'btw')).toBe('EMPTY')
  })

  it('apply() pushes the verb as a META-ONLY transaction — no doc change, no history', () => {
    const verbs = new CommandVerbDecorations(vendor().T)
    /** @type {any[]} */ const metas = []
    const tr = { setMeta: (/** @type {any} */ k, /** @type {any} */ v) => { metas.push(v); return tr } }
    /** @type {any[]} */ const dispatched = []
    verbs.apply({ state: { tr }, dispatch: (/** @type {any} */ x) => dispatched.push(x) }, 'btw')
    expect(metas).toEqual([{ verb: 'btw' }])
    expect(dispatched).toEqual([tr])
  })

  it('apply(null) is how a draft DISARMS — the same door, carrying no verb', () => {
    const verbs = new CommandVerbDecorations(vendor().T)
    /** @type {any[]} */ const metas = []
    const tr = { setMeta: (/** @type {any} */ k, /** @type {any} */ v) => { metas.push(v); return tr } }
    verbs.apply({ state: { tr }, dispatch: () => {} }, null)
    expect(metas).toEqual([{ verb: '' }])
  })

  it('TWO SURFACES DO NOT SHARE STATE: each instance owns its own plugin key', () => {
    const T = vendor().T
    const keyOf = (/** @type {any} */ v) => /** @type {any} */ (v.extension).addProseMirrorPlugins()[0].key
    expect(keyOf(new CommandVerbDecorations(T))).not.toBe(keyOf(new CommandVerbDecorations(T)))
  })

  it('a transaction carrying no verb meta LEAVES the state standing', () => {
    const plugin = /** @type {any} */ (
      new CommandVerbDecorations(vendor().T).extension).addProseMirrorPlugins()[0]
    const prev = { verb: 'btw' }
    expect(plugin.state.init()).toEqual({ verb: '' })
    expect(plugin.state.apply({ getMeta: () => undefined }, prev)).toBe(prev)
    expect(plugin.state.apply({ getMeta: () => ({ verb: 'uuid' }) }, prev)).toEqual({ verb: 'uuid' })
  })
})
