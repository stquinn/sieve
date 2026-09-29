// @ts-check
// CodeFormatAction — the one offer rule and the one write both code menus share.
//
// The write is asserted against a REAL ProseMirror document, because what it
// claims is about positions: it replaces the node's own content range and nothing
// else, in ONE transaction, and that transaction is TRACKED so undo reverts it.
// Which menu the item came from is wiring, and is asserted in the two menu suites.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { CodeFormatAction } from '../src/static/lens/document-editor/surfaces/code-format-action.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', ['code', 0]] },
    text: { group: 'inline' },
  },
})

/** A doc of one paragraph then one fence, and the fence's position.
 *  @param {string} source @returns {{state: any, pos: number}} */
function docWithFence(source) {
  const para = schema.nodes.paragraph.create(null, schema.text('before'))
  const fence = schema.nodes.codeBlock.create(null, source ? schema.text(source) : null)
  const doc = schema.nodes.doc.create(null, [para, fence])
  return { state: EditorState.create({ schema, doc }), pos: para.nodeSize }
}

/** A pane over a state, applying what it is dispatched so the result is readable.
 *  @param {any} state */
function paneOver(state) {
  const pane = {
    state,
    dispatched: /** @type {any[]} */ ([]),
    view: {
      dispatch(/** @type {any} */ tr) {
        pane.dispatched.push(tr)
        pane.state = pane.state.apply(tr)
      },
    },
  }
  return pane
}

/** A service double. @param {string[]} languages @param {(s: string) => Promise<string>} fn */
function serviceDouble(languages, fn) {
  return {
    calls: /** @type {string[][]} */ ([]),
    supports(/** @type {string} */ l) { return languages.includes(l) },
    supportedLanguages() { return languages },
    format(/** @type {string} */ l, /** @type {string} */ s) {
      this.calls.push([l, s])
      return fn(s)
    },
  }
}

/** @type {any} */ let alerted
beforeEach(() => {
  alerted = vi.fn()
  vi.stubGlobal('alert', alerted)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('CodeFormatAction.offer — when Format is on the menu', () => {
  const service = serviceDouble(['json'], (s) => Promise.resolve(s))
  const lens = { codeFormattingService: service }
  const base = { lens, pane: paneOver(docWithFence('x').state), node: {}, getPos: () => 1, editable: true }

  it('offers Format for a language the service supports', () => {
    const item = CodeFormatAction.offer({ ...base, language: 'json' })
    expect(item && item.label).toBe('Format')
    expect(typeof (item && item.action)).toBe('function')
  })

  it('offers nothing for a language nothing can format', () => {
    expect(CodeFormatAction.offer({ ...base, language: 'cobol' })).toBeNull()
    expect(CodeFormatAction.offer({ ...base, language: '' })).toBeNull()
  })

  it('offers nothing when the mount is not editable', () => {
    expect(CodeFormatAction.offer({ ...base, language: 'json', editable: false })).toBeNull()
  })

  // A lens mounted without a formatting service — or no lens at all, as in a bare
  // pane — simply has no Format. It is not an error and nothing is logged.
  it('offers nothing when the lens carries no formatting service', () => {
    expect(CodeFormatAction.offer({ ...base, lens: {}, language: 'json' })).toBeNull()
    expect(CodeFormatAction.offer({ ...base, lens: null, language: 'json' })).toBeNull()
  })
})

describe('CodeFormatAction.run — the write', () => {
  it('replaces the node content with what the service returned, in ONE tracked transaction', async () => {
    const { state, pos } = docWithFence('{"a":1}')
    const pane = paneOver(state)
    const service = serviceDouble(['json'], () => Promise.resolve('{\n  "a": 1\n}'))
    await CodeFormatAction.run({
      service, pane, node: pane.state.doc.nodeAt(pos), getPos: () => pos, language: 'json',
    })
    expect(service.calls).toEqual([['json', '{"a":1}']])
    expect(pane.dispatched.length).toBe(1)
    // Tracked: nothing set addToHistory false, so this is on the undo stack.
    expect(pane.dispatched[0].getMeta('addToHistory')).toBeUndefined()
    expect(pane.state.doc.nodeAt(pos).textContent).toBe('{\n  "a": 1\n}')
    // The paragraph before it is untouched — the write was the node's own range.
    expect(pane.state.doc.firstChild.textContent).toBe('before')
  })

  it('empties the node when the formatted source is empty', async () => {
    const { state, pos } = docWithFence('  ')
    const pane = paneOver(state)
    await CodeFormatAction.run({
      service: serviceDouble(['json'], () => Promise.resolve('')),
      pane, node: pane.state.doc.nodeAt(pos), getPos: () => pos, language: 'json',
    })
    expect(pane.state.doc.nodeAt(pos).textContent).toBe('')
  })

  it('alerts and writes nothing when the source does not parse', async () => {
    const { state, pos } = docWithFence('{bad')
    const pane = paneOver(state)
    await CodeFormatAction.run({
      service: serviceDouble(['json'], () => Promise.reject(new Error('unexpected token'))),
      pane, node: pane.state.doc.nodeAt(pos), getPos: () => pos, language: 'json',
    })
    expect(alerted).toHaveBeenCalledWith('Format failed: unexpected token')
    expect(pane.dispatched).toEqual([])
    expect(pane.state.doc.nodeAt(pos).textContent).toBe('{bad')
  })

  it('writes nothing when the source is already formatted', async () => {
    const { state, pos } = docWithFence('{ "a": 1 }')
    const pane = paneOver(state)
    await CodeFormatAction.run({
      service: serviceDouble(['json'], (s) => Promise.resolve(s)),
      pane, node: pane.state.doc.nodeAt(pos), getPos: () => pos, language: 'json',
    })
    expect(pane.dispatched).toEqual([])
  })

  // Formatting takes milliseconds, but a watcher reload or an AI job can land in
  // them. What is at that position is checked to still be the same node.
  it('writes nothing when the position went stale during the format', async () => {
    const { state, pos } = docWithFence('{"a":1}')
    const pane = paneOver(state)
    const node = pane.state.doc.nodeAt(pos)
    await CodeFormatAction.run({
      service: serviceDouble(['json'], () => Promise.resolve('{}')),
      pane, node, getPos: () => null, language: 'json',
    })
    await CodeFormatAction.run({
      service: serviceDouble(['json'], () => Promise.resolve('{}')),
      pane, node, getPos: () => 99999, language: 'json',
    })
    expect(pane.dispatched).toEqual([])
  })

  // The surface stays editable while Prettier loads, so the text can move on
  // under a format that is already running.
  it('writes nothing when the text changed while the format was running', async () => {
    const { state, pos } = docWithFence('{"a":1}')
    const pane = paneOver(state)
    const node = pane.state.doc.nodeAt(pos)
    await CodeFormatAction.run({
      service: serviceDouble(['json'], () => {
        // A keystroke, landing before the formatted string comes back.
        const tr = pane.state.tr.insertText('!', pos + 1)
        pane.state = pane.state.apply(tr)
        return Promise.resolve('{\n  "a": 1\n}')
      }),
      pane, node, getPos: () => pos, language: 'json',
    })
    expect(pane.dispatched).toEqual([])
    expect(pane.state.doc.nodeAt(pos).textContent).toBe('!{"a":1}')
  })

  it('writes nothing to a pane that has no view', async () => {
    const { state, pos } = docWithFence('{"a":1}')
    const service = serviceDouble(['json'], () => Promise.resolve('{}'))
    await CodeFormatAction.run({
      service, pane: { state }, node: state.doc.nodeAt(pos), getPos: () => pos, language: 'json',
    })
    expect(service.calls.length).toBe(1)
  })

  it('writes nothing when a DIFFERENT kind of node now sits at the position', async () => {
    const { state, pos } = docWithFence('{"a":1}')
    const pane = paneOver(state)
    const node = pane.state.doc.nodeAt(pos)
    // 0 is the paragraph: the same document, a node of another type.
    await CodeFormatAction.run({
      service: serviceDouble(['json'], () => Promise.resolve('{}')),
      pane, node, getPos: () => 0, language: 'json',
    })
    expect(pane.dispatched).toEqual([])
    expect(pane.state.doc.firstChild.textContent).toBe('before')
  })

  it('is reached by the menu item, which awaits nothing', async () => {
    const { state, pos } = docWithFence('{"a":1}')
    const pane = paneOver(state)
    const service = serviceDouble(['json'], () => Promise.resolve('{}'))
    const item = CodeFormatAction.offer({
      lens: { codeFormattingService: service }, pane,
      node: pane.state.doc.nodeAt(pos), getPos: () => pos, language: 'json', editable: true,
    })
    expect(/** @type {any} */ (item).action()).toBeUndefined()
    await vi.waitFor(() => expect(pane.dispatched.length).toBe(1))
    expect(pane.state.doc.nodeAt(pos).textContent).toBe('{}')
  })
})
