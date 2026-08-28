// @ts-check
// The pickers hosted in a DOCUMENT — `@` (mention a document) and `{` (insert a
// block), over one popover and one caret port.
//
// Driven against a REAL TipTap editor with the real interaction-policy
// extension, because a fake would grant all three of these for free:
//
//   1. KEY PRECEDENCE. The picker binds keydown in the CAPTURE phase on
//      `view.dom`; ProseMirror installs ONE bubble-phase listener on that same
//      element and dispatches every keymap from inside it. So the assertion is
//      not "the popover handled it" but "PM's handleKeyDown chain was never
//      reached", which needs a real view with a real listener on it.
//   2. `suppressTriggers`. The flag is read through the SAME resolveContext the
//      arrows and Tab go through, so the test puts a caret in a real
//      `sieve-code` node rather than asserting a boolean off a policy object.
//   3. ACCEPTANCE IS NOT A TEXT SUBSTITUTION here. `@Auth Design` and `{code`
//      alike delete the token and CREATE A BLOCK — with NO index and NO anchor,
//      because the editor owns all id→index math.
//
// The port under test is the SHIPPED CaretTriggerPort, not a re-typed copy.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor, Node, Extension } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Plugin, Selection, TextSelection, NodeSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { registerBlockKind } from '../src/static/renderers/block-kinds.js'
import {
  buildInteractionPolicyExtension, policyEnterKeydown, triggersSuppressed, CODE_TEXT_POLICY, DEFAULT_POLICY, policyFor,
} from '../src/static/lens/document-editor/interaction-policy.js'
import { CaretTriggerPort } from '../src/static/lens/document-editor/surfaces/caret-trigger-port.js'
import { ProseMirrorHost, CaretPlacement, TriggerHost, TextareaHost } from '../src/static/shell/trigger-host.js'
import { TriggerPopover } from '../src/static/shell/trigger-popover.js'
import { ActionMacro, BlockInsertProvider, BlockMacro, MentionProvider } from '../src/static/shell/trigger-providers.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

// CaretTriggerPort reads TextSelection off the vendor bag (test/setup.js installs
// it). Assign, never reassign — a reassignment orphans the captured bag.
Object.assign(/** @type {any} */ (globalThis).TipTap, { TextSelection })

// The SAME preset the real code-node-view.js / diagram-node-view.js declarations
// spread, so the fakes here cannot drift from what ships.
registerBlockKind({ kind: 'code', native: false, renderer: { interactionPolicy: { ...CODE_TEXT_POLICY } } })
registerBlockKind({ kind: 'prose', native: true, interactionPolicy: { surroundSelection: true } })

const SieveCode = Node.create({
  name: 'sieve-code',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() { return [{ tag: 'pre.sieve-code' }] },
  renderHTML() { return ['pre', { class: 'sieve-code' }, ['code', 0]] },
})

/** @type {any} */ let editor = null
/** @type {TriggerPopover|null} */ let popover = null

afterEach(() => {
  if (popover) { popover.destroy(); popover = null }
  if (editor) { editor.destroy(); editor = null }
  document.body.innerHTML = ''
})

/** Keys ProseMirror's own chain saw — the spy that proves precedence. */
/** @type {string[]} */ let pmSawKeys = []

function makeEditor(contentJSON) {
  pmSawKeys = []
  const element = document.createElement('div')
  document.body.appendChild(element)
  editor = new Editor({
    element,
    editorProps: {
      handleKeyDown: (view, event) => { pmSawKeys.push(event.key); return policyEnterKeydown(view, event) },
    },
    extensions: [
      StarterKit.configure({ trailingNode: true }),
      SieveCode,
      buildInteractionPolicyExtension({ Extension, Plugin, Selection, TextSelection, NodeSelection, Decoration, DecorationSet }),
    ],
    content: contentJSON,
  })
  return editor
}

function caretAt(pos) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

/**
 * A doc position `offset` characters into the first `typeName` node. Resolved
 * rather than counted, because StarterKit's trailingNode guarantee (caret
 * contract clause 1) appends an empty paragraph after the last block — so the
 * end of the doc is never the end of the last block.
 */
function caretInside(typeName, offset = 0) {
  let start = null
  editor.state.doc.forEach((node, pos) => { if (start === null && node.type.name === typeName) start = pos })
  caretAt(start + 1 + offset)
}

/** A candidate source with no socket behind it. */
function sourceOf(...candidates) {
  return { search: () => Promise.resolve(candidates) }
}

/** The editor the port creates blocks through — records the call SHAPE. */
function fakeEditorHost() {
  return { createBlock: vi.fn() }
}

/** A catalog of kind macros, as MacroCatalog composes them. */
function kindsOf(...kinds) {
  return { list: () => kinds.map((k) => new BlockMacro(k)) }
}

/** A catalog whose entries are kind macros plus verb macros. */
function macrosOf(kinds, ...verbs) {
  return { list: () => kinds.map((k) => new BlockMacro(k)).concat(verbs) }
}

/** Builds the picker over the real view, exactly as WysiwygSurface does. */
function mountPicker({ host = fakeEditorHost(), flush = vi.fn(), source = sourceOf(), kinds = kindsOf() } = {}) {
  const port = new CaretTriggerPort(editor, host, flush)
  popover = new TriggerPopover(
    new ProseMirrorHost(port),
    [new BlockInsertProvider(kinds), new MentionProvider(source, undefined, { debounceMs: 0 })],
    new CaretPlacement(),
  )
  return { host, flush, port }
}

/** Types `text` at the caret as a real user edit (fires the `update` stream). */
function type(text) {
  editor.commands.insertContent(text)
}

/** Lets the provider's debounce + its promise settle. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

/** Dispatches a REAL keydown on the editable root, as the browser would. */
function pressReal(key, opts = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  editor.view.dom.dispatchEvent(event)
  return event
}

function popoverEl() {
  return /** @type {HTMLElement} */ (document.querySelector('.command-hint-popover'))
}

function isOpen() {
  const el = popoverEl()
  return !!el && el.style.display !== 'none'
}

const PARA = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] })

// ── suppressTriggers: declared in the preset, read through the policy ────────

describe('suppressTriggers — the flag and its reader', () => {
  it('defaults off and is opted INTO by the code preset (so code AND diagram get it from one line)', () => {
    expect(DEFAULT_POLICY.suppressTriggers).toBe(false)
    expect(CODE_TEXT_POLICY.suppressTriggers).toBe(true)
    expect(policyFor('code').suppressTriggers).toBe(true)
    expect(policyFor('prose').suppressTriggers).toBe(false)
  })

  it('is read through resolveContext, so it follows the CARET and not the document', () => {
    makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'prose here' }] },
        { type: 'sieve-code', content: [{ type: 'text', text: '@Override' }] },
      ],
    })
    caretAt(5)
    expect(triggersSuppressed(editor.state, editor.view)).toBe(false)
    caretInside('sieve-code', 3)
    expect(triggersSuppressed(editor.state, editor.view)).toBe(true)
  })

  it('the port answers NOTHING TO SCAN inside a suppressing block', () => {
    makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello @au' }] },
        { type: 'sieve-code', content: [{ type: 'text', text: '@Override' }] },
      ],
    })
    const port = new CaretTriggerPort(editor, fakeEditorHost(), () => {})

    caretAt(10)                                        // end of "hello @au"
    expect(port.caretText()).toEqual({ text: 'hello @au', caret: 9 })

    caretInside('sieve-code', 3)                        // inside the code block
    expect(port.caretText()).toBeNull()
  })

  it('so `@Override` in a code block never arms the picker', async () => {
    makeEditor({ type: 'doc', content: [{ type: 'sieve-code', content: [{ type: 'text', text: 'x' }] }] })
    mountPicker({ source: sourceOf({ uri: 'container:1', title: 'Override Notes' }) })
    caretInside('sieve-code', 1)
    type('@Over')
    await settle()
    expect(isOpen()).toBe(false)
  })
})

// ── The port ────────────────────────────────────────────────────────────────

describe('CaretTriggerPort — what a live caret can answer', () => {
  it('refuses a host with a missing port method (the seam does not lie)', () => {
    expect(() => new ProseMirrorHost(/** @type {any} */ ({ element: () => document.body })))
      .toThrow(ContractViolation)
  })

  it('scans the caret\'s own textblock, with BLOCK-LOCAL offsets', () => {
    makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'ask @au about it' }] },
      ],
    })
    const port = new CaretTriggerPort(editor, fakeEditorHost(), () => {})
    caretAt(15)   // inside the SECOND paragraph, right after "@au"
    // Offsets are relative to the block, not the document: the second paragraph
    // starts at doc pos 7, and the token still reports start 4.
    expect(port.caretText()).toEqual({ text: 'ask @au about it', caret: 7 })

    const host = new ProseMirrorHost(port)
    const providers = new Map([['@', new MentionProvider(sourceOf())]])
    const token = host.tokenAtCaret(providers)
    expect(token && { start: token.start, end: token.end, prefix: token.prefix })
      .toEqual({ start: 4, end: 7, prefix: 'au' })
    expect(host.textAfter(7)).toBe(' about it')
  })

  it('has nothing to scan without a collapsed caret in a textblock', () => {
    makeEditor(PARA('hello @au'))
    const port = new CaretTriggerPort(editor, fakeEditorHost(), () => {})
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6)))
    expect(port.caretText()).toBeNull()
  })

  it('replaceRange substitutes over block-local offsets as ONE TRACKED transaction', () => {
    makeEditor(PARA('ask @au about it'))
    const port = new CaretTriggerPort(editor, fakeEditorHost(), () => {})
    caretAt(8)
    const before = editor.state.doc.textContent
    port.replaceRange(4, 7, '@Auth Design')
    expect(editor.state.doc.textContent).toBe('ask @Auth Design about it')
    // Tracked: one Ctrl+Z puts it back. A completion that could not be undone
    // would be a doc mutation the user cannot argue with.
    editor.commands.undo()
    expect(editor.state.doc.textContent).toBe(before)
  })
})

// ── Acceptance creates a BLOCK ──────────────────────────────────────────────

describe('accepting a mention in a document', () => {
  it('deletes the token, flushes, and creates a `reference` block with NO anchor', async () => {
    makeEditor(PARA('see @au for detail'))
    const { host, flush } = mountPicker({
      source: sourceOf({ uri: 'sieve://9f2b', title: 'Auth Design', detail: 'note' }),
    })
    caretAt(8)                                     // "see @au|"
    type('t')                                      // → "see @aut|"
    await settle()
    expect(isOpen()).toBe(true)

    pressReal('Enter')

    // The token is GONE and nothing was echoed in its place: the chip in the
    // document IS the reference, so there is no `@Title` text to reconcile.
    expect(editor.state.doc.textContent).toBe('see  for detail')
    // Go's shadow gets the deletion BEFORE the create arrives on the same socket.
    expect(flush).toHaveBeenCalledTimes(1)
    // The anchor argument is OMITTED — never an index. The editor derives the
    // index from the caret, which is what applies the empty-line placement rule.
    expect(host.createBlock).toHaveBeenCalledTimes(1)
    expect(host.createBlock.mock.calls[0]).toEqual(['reference',
      { uri: 'sieve://9f2b', cache: { title: 'Auth Design' } }])
    expect(host.createBlock.mock.calls[0].length).toBe(2)
  })

  it('seeds the WHOLE face, so the block is born complete and never resolves to render', async () => {
    makeEditor(PARA('see @au for detail'))
    const { host } = mountPicker({
      source: sourceOf({
        uri: 'sieve://9f2b', title: 'Auth Design', kind: 'note',
        summary: 'Token rotation and session binding',
      }),
    })
    caretAt(8)
    type('t')
    await settle()
    pressReal('Enter')

    // `mime` is the candidate's kind in Sieve's own space — the same spelling the
    // processor stamps on resolve, and what tells pointing from holding.
    expect(host.createBlock.mock.calls[0]).toEqual(['reference', {
      uri: 'sieve://9f2b',
      cache: {
        title: 'Auth Design',
        summary: 'Token rotation and session binding',
        mime: 'sieve/note',
      },
    }])
  })

  it('leaves the caret\'s line EMPTY when the token had it to itself — the placement rule\'s input', async () => {
    makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '@au' }] },
      ],
    })
    const { host } = mountPicker({ source: sourceOf({ uri: 'sieve://9f2b', title: 'Auth Design' }) })
    caretAt(11)     // end of the second paragraph's "@au"
    type('t')
    await settle()
    pressReal('Tab')

    // An empty paragraph at the caret is exactly what the editor's
    // commitInsertIndex consumes, so the block BECOMES that node in place.
    expect(editor.state.doc.child(1).textContent).toBe('')
    expect(host.createBlock).toHaveBeenCalledWith('reference',
      { uri: 'sieve://9f2b', cache: { title: 'Auth Design' } })
  })

  it('a mouse pick means the same thing as a key pick', async () => {
    makeEditor(PARA('see @au'))
    const { host } = mountPicker({ source: sourceOf({ uri: 'sieve://1', title: 'Auth Design' }) })
    caretAt(8)
    type('t')
    await settle()

    const row = /** @type {HTMLElement} */ (popoverEl().querySelector('.command-hint-item'))
    row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    expect(host.createBlock).toHaveBeenCalledWith('reference',
      { uri: 'sieve://1', cache: { title: 'Auth Design' } })
  })
})

// ── Inserting a block by name ───────────────────────────────────────────────

describe('inserting a block from `{` in a document', () => {
  const CODE = { kind: 'code', label: 'Code', description: 'Source, syntax-highlighted' }
  const DIAGRAM = { kind: 'diagram', label: 'Diagram', description: 'Mermaid or PlantUML' }

  it('deletes the token, flushes, and creates the named kind with NO anchor', async () => {
    makeEditor(PARA('notes {co'))
    const { host, flush } = mountPicker({ kinds: kindsOf(CODE, DIAGRAM) })
    caretAt(10)                                    // "notes {co|"
    type('d')                                      // → "notes {cod|"
    await settle()
    expect(isOpen()).toBe(true)

    pressReal('Enter')

    // The typed name is GONE: what the user asked for is the block, not the word.
    expect(editor.state.doc.textContent).toBe('notes ')
    expect(flush).toHaveBeenCalledTimes(1)
    // Empty attrs — every default is the server's to fill — and the anchor
    // argument is OMITTED, never an index.
    expect(host.createBlock.mock.calls[0]).toEqual(['code', {}])
    expect(host.createBlock.mock.calls[0].length).toBe(2)
  })

  it('leaves the caret\'s line EMPTY when the token had it to itself — the placement rule\'s input', async () => {
    makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '{diag' }] },
      ],
    })
    const { host } = mountPicker({ kinds: kindsOf(CODE, DIAGRAM) })
    caretAt(13)                                    // end of the second paragraph
    type('r')
    await settle()
    pressReal('Tab')

    expect(editor.state.doc.child(1).textContent).toBe('')
    expect(host.createBlock).toHaveBeenCalledWith('diagram', {})
  })

  it('never arms inside a raw-text block — a brace there is a literal brace', async () => {
    makeEditor({ type: 'doc', content: [{ type: 'sieve-code', content: [{ type: 'text', text: 'x' }] }] })
    const { host } = mountPicker({ kinds: kindsOf(CODE) })
    caretInside('sieve-code', 1)
    type('{cod')
    await settle()
    expect(isOpen()).toBe(false)
    expect(host.createBlock).not.toHaveBeenCalled()
  })
})

// ── Running a verb from `{` ─────────────────────────────────────────────────
//
// The other half of the entry model (#91 phase 2): an entry that FRONTS a
// capability rather than creating a block. What must hold against a real
// document is the ORDER — the token is gone before the verb runs — because the
// verb may be a dialog the user then dismisses, and there is no second chance to
// tidy the line.

describe('running a verb from `{` in a document', () => {
  const CODE = { kind: 'code', label: 'Code', description: 'Source, syntax-highlighted' }

  /** @param {() => void} action */
  function verb(action) {
    return new ActionMacro({ label: 'Web Clip', name: 'web-clip', description: 'Capture a page', action })
  }

  it('deletes the token BEFORE the verb runs, and creates nothing', async () => {
    /** @type {string[]} */ const seen = []
    makeEditor(PARA('notes {we'))
    const openDialog = vi.fn(() => { seen.push(editor.state.doc.textContent) })
    const { host, flush } = mountPicker({ kinds: macrosOf([CODE], verb(openDialog)) })
    caretAt(10)                                    // "notes {we|"
    type('b')                                      // → "notes {web|"
    await settle()
    expect(isOpen()).toBe(true)

    pressReal('Enter')

    expect(editor.state.doc.textContent).toBe('notes ')
    // The line was ALREADY clean when the dialog opened — a dismissal from here
    // leaves nothing behind.
    expect(seen).toEqual(['notes '])
    expect(openDialog).toHaveBeenCalledTimes(1)
    // The dialog owns the create, so nothing has been asked for yet — and there
    // is no block create to order a flush against.
    expect(host.createBlock).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('clears the token as a TRACKED edit — Ctrl+Z brings it back', async () => {
    makeEditor(PARA('notes {we'))
    mountPicker({ kinds: macrosOf([CODE], verb(() => {})) })
    caretAt(10)
    type('b')
    await settle()
    pressReal('Enter')
    expect(editor.state.doc.textContent).toBe('notes ')

    // ProseMirror groups the clear with the keystroke that armed the picker —
    // both fall inside newGroupDelay — so one undo returns the token less that
    // last character. What is pinned is that the deletion is undoable at all.
    editor.commands.undo()
    expect(editor.state.doc.textContent).toBe('notes {we')
  })
})

// ── Key precedence: the picker beats the interaction policy ─────────────────

describe('key precedence while the picker is open', () => {
  async function openPicker() {
    makeEditor(PARA('see @au'))
    const wired = mountPicker({
      source: sourceOf(
        { uri: 'container:1', title: 'Auth Design' },
        { uri: 'container:2', title: 'Auth Rotation' },
      ),
    })
    caretAt(8)
    type('t')
    await settle()
    expect(isOpen()).toBe(true)
    pmSawKeys = []      // the typing itself is not what these assert about
    return wired
  }

  it('ArrowDown/ArrowUp move the selection and NEVER reach ProseMirror', async () => {
    await openPicker()
    const e = pressReal('ArrowDown')
    expect(e.defaultPrevented).toBe(true)
    expect(pmSawKeys).toEqual([])
    expect(popoverEl().querySelectorAll('.command-hint-item.is-active').length).toBe(1)
    expect(popoverEl().querySelectorAll('.command-hint-item')[1].className).toContain('is-active')

    pressReal('ArrowUp')
    expect(pmSawKeys).toEqual([])
    expect(popoverEl().querySelectorAll('.command-hint-item')[0].className).toContain('is-active')
  })

  it('Enter accepts instead of splitting the paragraph', async () => {
    const { host } = await openPicker()
    const before = editor.state.doc.childCount
    const e = pressReal('Enter')
    expect(e.defaultPrevented).toBe(true)
    expect(pmSawKeys).toEqual([])                 // policyEnterKeydown never ran
    expect(editor.state.doc.childCount).toBe(before)   // no split
    expect(host.createBlock).toHaveBeenCalledTimes(1)
  })

  it('Tab accepts instead of reaching the policy\'s Tab backstop', async () => {
    const { host } = await openPicker()
    const e = pressReal('Tab')
    expect(e.defaultPrevented).toBe(true)
    expect(pmSawKeys).toEqual([])
    expect(host.createBlock).toHaveBeenCalledTimes(1)
  })

  it('Shift+Tab as WebKitGTK spells it (ISO_Left_Tab / keyCode 9) is still Tab', async () => {
    // WebKitGTK reports the X11 keysym in event.key where Chrome says 'Tab'.
    // Matching the name alone would let Shift+Tab fall through to the policy's
    // Tab backstop while the list is up — the failure this three-way match exists
    // to stop, and the same match the policy extension already makes.
    const { host } = await openPicker()
    const e = pressReal('ISO_Left_Tab', { shiftKey: true, keyCode: 9 })
    expect(e.defaultPrevented).toBe(true)
    expect(pmSawKeys).toEqual([])
    expect(host.createBlock).toHaveBeenCalledTimes(1)
  })

  it('Escape abandons the token rather than reaching the block-escape behind it', async () => {
    const { host } = await openPicker()
    const e = pressReal('Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(pmSawKeys).toEqual([])
    expect(isOpen()).toBe(false)
    expect(host.createBlock).not.toHaveBeenCalled()
    expect(editor.state.doc.textContent).toBe('see @aut')   // the text is left alone
  })

  it('Shift+Enter is NOT the picker\'s — the universal block escape still reaches PM', async () => {
    await openPicker()
    pressReal('Enter', { shiftKey: true })
    expect(pmSawKeys).toEqual(['Enter'])
  })

  it('an ordinary key passes straight through to the editor', async () => {
    await openPicker()
    pressReal('a')
    expect(pmSawKeys).toEqual(['a'])
  })

  it('a SHUT picker intercepts nothing at all', () => {
    makeEditor(PARA('hello'))
    mountPicker()
    caretAt(3)
    pressReal('Enter')
    pressReal('Escape')
    pressReal('ArrowDown')
    expect(pmSawKeys).toEqual(['Enter', 'Escape', 'ArrowDown'])
  })
})

// ── Token abandonment survives the move into a document ─────────────────────

describe('typing a literal `@` in prose (#74 P5, inherited)', () => {
  it('Escape stays dismissed as you type FORWARD, and backspacing re-arms', async () => {
    makeEditor(PARA('mail '))
    mountPicker({ source: sourceOf({ uri: 'container:1', title: 'Auth Design' }) })
    caretAt(6)
    type('@au')
    await settle()
    expect(isOpen()).toBe(true)

    pressReal('Escape')
    expect(isOpen()).toBe(false)

    type('th')                       // typing forward stays closed
    await settle()
    expect(isOpen()).toBe(false)

    editor.commands.deleteRange({ from: 8, to: 11 })   // back to "@a"
    await settle()
    expect(isOpen()).toBe(true)      // a shorter prefix re-arms it
  })

  it('a dry query closes the picker and keeps it closed', async () => {
    makeEditor(PARA(''))
    mountPicker({ source: sourceOf() })       // nothing ever matches
    caretAt(1)
    type('@nosuchthing')
    await settle()
    expect(isOpen()).toBe(false)
  })

  it('never arms mid-word, so an email address is an email address', async () => {
    makeEditor(PARA('write me'))
    mountPicker({ source: sourceOf({ uri: 'container:1', title: 'Auth Design' }) })
    caretAt(9)
    type('@au')
    await settle()
    expect(isOpen()).toBe(false)              // `me@au` fails acceptsBoundary
  })
})

// ── Placement ───────────────────────────────────────────────────────────────

describe('CaretPlacement — anchored to the caret, flipping when it must', () => {
  /** A host that reports one fixed caret rect. */
  class RectHost extends TriggerHost {
    constructor(rect) { super(); this.rect = rect }
    anchorElement() { return document.body }
    anchorRect() { return /** @type {any} */ (this.rect) }
  }

  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })

  it('hangs BELOW the caret line when the room is there', () => {
    const el = document.createElement('div')
    new CaretPlacement().place(el, new RectHost({ left: 120, top: 40, bottom: 60, right: 121 }))
    expect(el.style.top).toBe('64px')
    expect(el.style.bottom).toBe('')
    expect(el.style.boxShadow).toContain('0 8px 24px')
  })

  it('flips ABOVE when the caret is near the bottom and there is more room up', () => {
    const { h } = viewport()
    const el = document.createElement('div')
    new CaretPlacement().place(el, new RectHost({ left: 120, top: h - 30, bottom: h - 10, right: 121 }))
    expect(el.style.top).toBe('')
    expect(el.style.bottom).toBe((h - (h - 30) + 4) + 'px')
    expect(el.style.boxShadow).toContain('0 -8px 24px')
  })

  it('drops DOWN rather than up when neither side fits — the first rows matter most', () => {
    const el = document.createElement('div')
    // A caret 20px from the top of a viewport too short for the list either way.
    new CaretPlacement().place(el, new RectHost({ left: 10, top: 20, bottom: 40, right: 11 }))
    expect(el.style.top).toBe('44px')
  })

  it('an OPEN list is re-placed when the document scrolls under it', async () => {
    // The caret moves with the page; a list anchored to it and left where it was
    // is worse than one that never opened. Typing re-places it for free (render →
    // show), so this is specifically the no-keystroke case.
    makeEditor(PARA('see @au'))
    const { port } = mountPicker({ source: sourceOf({ uri: 'container:1', title: 'Auth Design' }) })
    caretAt(8)
    type('t')
    await settle()
    expect(isOpen()).toBe(true)

    let y = 400
    port.caretRect = () => /** @type {any} */ ({ left: 60, top: y, bottom: y + 20, right: 61 })
    window.dispatchEvent(new window.Event('scroll'))
    const first = popoverEl().style.top
    y = 120
    window.dispatchEvent(new window.Event('scroll'))
    expect(popoverEl().style.top).not.toBe(first)
    expect(popoverEl().style.top).toBe('144px')
  })

  it('leaves a SHUT list alone — nothing is measured for a picker nobody sees', async () => {
    makeEditor(PARA('hello'))
    mountPicker()
    const el = popoverEl()
    el.style.top = '999px'
    window.dispatchEvent(new window.Event('scroll'))
    expect(el.style.top).toBe('999px')
  })

  it('sizes to its CONTENT, bounded by the editor column', () => {
    // The list is as wide as its longest title or as wide as the editor,
    // whichever is shorter. A fixed cap wrapped ordinary document titles onto
    // four lines, which is the defect this replaced.
    const el = document.createElement('div')
    new CaretPlacement().place(el, new RectHost({ left: 120, top: 40, bottom: 60, right: 121 }))
    expect(el.style.width).toBe('max-content')
    expect(parseInt(el.style.maxWidth, 10)).toBeGreaterThan(0)
  })

  it('never runs off the right edge', () => {
    const { w } = viewport()
    const el = document.createElement('div')
    new CaretPlacement().place(el, new RectHost({ left: w - 5, top: 100, bottom: 120, right: w - 4 }))
    // offsetWidth is 0 without layout, so the clamp falls back to maxWidth —
    // the widest the list could possibly be, which is the safe bound to test.
    const bound = parseInt(el.style.maxWidth, 10)
    expect(parseInt(el.style.left, 10) + bound).toBeLessThanOrEqual(w - 8)
  })
})

// ── The composer is untouched ───────────────────────────────────────────────

describe('the composer keeps its own meaning of accepting', () => {
  it('a textarea host still gets `@Title` in the text and a candidate in the sink', () => {
    document.body.innerHTML = '<div id="ask-panel"><textarea class="ask-popup__input"></textarea></div>'
    const textarea = /** @type {HTMLTextAreaElement} */ (document.querySelector('.ask-popup__input'))
    const sink = vi.fn()
    const provider = new MentionProvider(sourceOf(), sink)
    const host = new TextareaHost(textarea)
    textarea.value = 'How does @au handle this?'

    provider.accept(
      { uri: 'container:9f2b', title: 'Auth Design' },
      Object.freeze({ provider, start: 9, end: 12, prefix: 'au' }),
      host,
    )

    // A textarea has nowhere to put a block, so the chip is the compensation —
    // unchanged by #38, and the else-branch of the one accept.
    expect(textarea.value).toBe('How does @Auth Design handle this?')
    expect(sink).toHaveBeenCalledWith({ uri: 'container:9f2b', title: 'Auth Design' })
  })
})

// ── A PM-native preset in a document ────────────────────────────────────────

describe('a preset macro that wraps at the caret', () => {
  it('leaves the caret INSIDE the quote, so the next keystroke lands in it', async () => {
    makeEditor(PARA('{quo'))
    const quote = new ActionMacro({
      label: 'Quote', name: 'blockquote', description: 'An indented quotation',
      action: () => { editor.chain().focus().toggleBlockquote().run() },
    })
    mountPicker({ kinds: macrosOf([], quote) })
    caretAt(5)
    type('t')
    await settle()
    expect(isOpen()).toBe(true)

    pressReal('Enter')

    const $from = editor.state.selection.$from
    let inQuote = false
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'blockquote') inQuote = true
    }
    expect(inQuote).toBe(true)

    editor.view.dispatch(editor.state.tr.insertText('hi'))
    const bq = editor.state.doc.content.child(0)
    expect(bq.type.name).toBe('blockquote')
    expect(bq.textContent).toBe('hi')
  })
})
