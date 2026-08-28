// @ts-check
// composer-mount.test.js — the HOST's arrangement for one draft (#118): the
// harvest that turns what was written into the list of blocks a question IS, the
// key claims the mount makes, and the proof that a composer-authored question
// reaches the ask seam indistinguishable from a hand-built #101 one.
//
// THE HARVEST IS A PROVIDER READ, so it is driven here through the draft
// container itself rather than through ProseMirror: the lens's own observer has
// already written what was typed into that container as blocks, and what is
// under test is the walk, not the typing.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { ComposerMount } from '../src/static/shell/composer-mount.js'
import { ComposerEditor } from '../src/static/lens/composer/composer-editor.js'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { EditorMode } from '../src/static/lens/document-editor/editor-mode.js'
import { InMemoryContainerProvider } from '../src/static/container/in-memory-container-provider.js'
import { QuestionList, QuestionRel } from '../src/static/renderers/question-list.js'
import { Ident } from '../src/static/ident/ident.js'

// The owner modules that run vendor calls at IMPORT time and would crash under
// the bare test/setup.js TipTap seed. Nothing here mounts a surface.
vi.mock('../src/static/lens/extensions.js', () => ({
  Search: {}, SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  buildAiContext: vi.fn((ctx) => ({ blockRef: (ctx && ctx.target && ctx.target.ref) || 'doc' })),
  applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {}, getBlockSelectionRange: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))

/** @type {AbstractEditor[]} */ const built = []
afterEach(() => { while (built.length) /** @type {any} */ (built.pop()).destroy() })

/** A draft holding exactly these prose blocks, as the lens's observer writes
 *  them: one `prose` block per top-level node, its markdown in `content`. */
function draftOf(...contents) {
  return new InMemoryContainerProvider({
    blocks: contents.map((content, i) => ({ id: 'blk-' + i, kind: 'prose', attrs: { content } })),
  })
}

/** A draft holding exactly these blocks, in this order. */
function draftHolding(...blocks) {
  return new InMemoryContainerProvider({ blocks: blocks })
}

/** @param {string} content @param {string} id */
const proseBlock = (content, id) => ({ id: id, kind: 'prose', attrs: { content: content } })

/** The block an accepted `@` mention mints into the draft: the question element
 *  that IS the attachment, named by a draft-local uuid. */
function attachmentBlock(uri, title, id = 'att-0') {
  const element = QuestionList.attachment(uri, title)
  return { id: id, kind: element.kind, attrs: Object.assign({ id: id }, element.attrs) }
}

const A_KEY = (key, mods = {}) => /** @type {any} */ (Object.assign(
  { key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }, mods))

describe('ComposerMount — the harvest', () => {
  it('one prose block becomes one prose element, carrying the id the lens minted', () => {
    expect(ComposerMount.elementsOf(draftOf('why is the sky blue?'))).toEqual([
      { kind: 'prose', attrs: { id: 'blk-0', content: 'why is the sky blue?' } },
    ])
  })

  it('walks the draft IN ORDER — a question is a sequence, not a set', () => {
    const elements = ComposerMount.elementsOf(draftOf('first', 'second', 'third'))
    expect(elements.map((e) => e.attrs.content)).toEqual(['first', 'second', 'third'])
  })

  it('skips a block that says nothing — a blank line is spacing, not a block', () => {
    expect(ComposerMount.elementsOf(draftOf('one', '   ', '', 'two')).map((e) => e.attrs.content))
      .toEqual(['one', 'two'])
  })

  it('a WHOLE fenced block becomes a code element, with the language the author tagged', () => {
    expect(ComposerMount.elementsOf(draftOf('```go\nfunc main() {}\n```'))).toEqual([
      { kind: 'code', attrs: { id: 'blk-0', source: 'func main() {}', language: 'go' } },
    ])
  })

  it('an UNTAGGED fence carries no language — nothing here guesses what was typed', () => {
    expect(ComposerMount.elementsOf(draftOf('```\nplain text\n```'))).toEqual([
      { kind: 'code', attrs: { id: 'blk-0', source: 'plain text' } },
    ])
  })

  it('a multi-line fence keeps its source verbatim, blank lines and all', () => {
    const [element] = ComposerMount.elementsOf(draftOf('```py\ndef f():\n\n    return 1\n```'))
    expect(element.attrs.source).toBe('def f():\n\n    return 1')
  })

  it('a fence with prose AROUND it stays PROSE — the block is not wholly a fence', () => {
    const [element] = ComposerMount.elementsOf(draftOf('look:\n```go\nx := 1\n```'))
    expect(element.kind).toBe('prose')
    expect(element.attrs.content).toBe('look:\n```go\nx := 1\n```')
  })

  it('markdown that is NOT a fence stays prose, structure intact', () => {
    const [element] = ComposerMount.elementsOf(draftOf('- one\n- two'))
    expect(element).toEqual({ kind: 'prose', attrs: { id: 'blk-0', content: '- one\n- two' } })
  })

  it('a mixed draft harvests as the mixed list it was written as', () => {
    const elements = ComposerMount.elementsOf(
      draftOf('why does this panic?', '```go\npanic("x")\n```', 'and what should it do?'))
    expect(elements.map((e) => e.kind)).toEqual(['prose', 'code', 'prose'])
  })

  it('an empty draft harvests to nothing', () => {
    expect(ComposerMount.elementsOf(new InMemoryContainerProvider())).toEqual([])
  })
})

// ── THE ATTACHMENT IS A BLOCK OF THE DRAFT (#118 final) ──────────────────────
//
// Accepting a `@` candidate writes ONE attach-rel reference element into the
// draft, so the harvest picks it up as part of the walk and nothing rides
// alongside the list. Its draft-local id does NOT travel: the authority the
// question lands in names an id-less element at the door.
describe('ComposerMount — the harvest of what was attached', () => {
  it('an attachment harvests as the reference element it is, WITHOUT its draft id', () => {
    expect(ComposerMount.elementsOf(draftHolding(attachmentBlock('sieve://other', 'Auth Design'))))
      .toEqual([{
        kind: 'reference',
        attrs: { uri: 'sieve://other', rel: QuestionRel.ATTACH, cache: { title: 'Auth Design' } },
      }])
  })

  it('an attachment with no title carries no face', () => {
    expect(ComposerMount.elementsOf(draftHolding(attachmentBlock('sieve://other', ''))))
      .toEqual([{ kind: 'reference', attrs: { uri: 'sieve://other', rel: QuestionRel.ATTACH } }])
  })

  it('it lands where the draft holds it — the walk is container order, whatever the kind', () => {
    const elements = ComposerMount.elementsOf(draftHolding(
      proseBlock('why does this panic?', 'blk-0'),
      attachmentBlock('sieve://other', 'Auth Design'),
      proseBlock('and what should it do?', 'blk-1')))
    expect(elements.map((e) => e.kind)).toEqual(['prose', 'reference', 'prose'])
  })
})

describe('ComposerMount — the draft lifetime', () => {
  it('headless (no fixture) opens nothing and harvests nothing', () => {
    const mount = new ComposerMount(null)
    expect(mount.open()).toBeNull()
    expect(mount.harvest()).toEqual([])
    expect(mount.read()).toBe('')
    expect(mount.isEmpty()).toBe(true)
    expect(mount.hasFocus()).toBe(false)
  })
})

// ── THE KEY CLAIMS (#118 3d — editor-first) ──────────────────────────────────
//
// A claim is PER-MOUNT CONFIGURATION and precedence is FOCUS: the surface asks
// the lens whose view the keystroke landed in, so two live editors on one page
// never contend. What is pinned here is each lens's ANSWER — the note mount
// claiming nothing at all is as load-bearing as the composer claiming
// Mod+Enter, because it is what proves the note's Enter behaviour untouched by
// this issue.
//
// `window.isMod` is an index.html global in the app (Mac → metaKey, else →
// ctrlKey); provide it here as `surfaces.test.js` does for the same reason.
describe('the composer mount claims Mod+Enter, and only Mod+Enter', () => {
  beforeEach(() => { window.isMod = (e) => !!(e.ctrlKey || e.metaKey) })

  /** @param {object} [options] */
  function composer(options = {}) {
    const editor = new ComposerEditor(Ident.mint(),
      Object.assign({ provider: new InMemoryContainerProvider() }, options))
    built.push(editor)
    return editor
  }

  it('claims Ctrl+Enter and reports the message finished', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)
    expect(editor.claimKey(A_KEY('Enter', { ctrlKey: true }))).toBe(true)
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('claims Cmd+Enter and reports the message finished', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)
    expect(editor.claimKey(A_KEY('Enter', { metaKey: true }))).toBe(true)
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('claims Mod+Enter exactly once per keydown — submit fires exactly once', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)
    editor.claimKey(A_KEY('Enter', { metaKey: true }))
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('does NOT claim a bare Enter — it reaches the editor, native paragraph split', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)
    expect(editor.claimKey(A_KEY('Enter'))).toBe(false)
    expect(finished).not.toHaveBeenCalled()
  })

  it('does NOT claim Shift+Enter — it reaches the editor, native soft break', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)
    expect(editor.claimKey(A_KEY('Enter', { shiftKey: true }))).toBe(false)
    expect(finished).not.toHaveBeenCalled()
  })

  it('does NOT claim Alt+Enter — it reaches the editor, no dedicated hard-break path', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)
    expect(editor.claimKey(A_KEY('Enter', { altKey: true }))).toBe(false)
    expect(finished).not.toHaveBeenCalled()
  })

  it('claims NOTHING else — every other key falls through to the surface', () => {
    const editor = composer()
    for (const key of ['Escape', 'Tab', 'a', 'Backspace', 'ArrowDown', 'Home']) {
      expect(editor.claimKey(A_KEY(key))).toBe(false)
    }
  })

  it('an unsubscribed submit listener stops hearing', () => {
    const editor = composer()
    const finished = vi.fn()
    editor.onSubmit(finished)()
    editor.claimKey(A_KEY('Enter', { metaKey: true }))
    expect(finished).not.toHaveBeenCalled()
  })

  it('THE NOTE MOUNT CLAIMS NOTHING: its Enter behaviour is untouched by this issue', () => {
    class BareLens extends AbstractEditor {
      get _defaultMode() { return EditorMode.WYSIWYG }
      paint() {}
    }
    const note = new BareLens(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(note)
    for (const key of ['Enter', 'Escape', 'Tab', 'a']) {
      for (const mods of [{}, { shiftKey: true }, { altKey: true }, { metaKey: true }]) {
        expect(note.claimKey(A_KEY(key, mods))).toBe(false)
      }
    }
  })
})

describe('what the composer lens says about itself', () => {
  it('THE COMPOSER HAS NO PLACEHOLDER: the chords, Send and focus ring are invitation enough (#118 fix round 5)', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    expect(editor.placeholder).toBe('')
  })

  it('publishes NO spec before there is a lens to ask — the footer says nothing yet', () => {
    expect(new ComposerMount(null).capabilities()).toBeNull()
  })
})

describe('the composer mount marks the @Title tokens its host says are attached', () => {
  it('is a no-op before there is a draft to mark', () => {
    expect(() => new ComposerMount(null).setMentionTitles(['Auth Design'])).not.toThrow()
  })

  it('a lens with no surface mounted marks nothing and does not throw', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    expect(() => editor.setMentionTitles(['Auth Design'])).not.toThrow()
  })
})

describe('the composer mount passes an accepted mention on', () => {
  it('hands the candidate to whoever keeps the draft\'s manifest', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    const sink = vi.fn()
    editor.onMention(sink)
    editor.onMentionAccepted({ uri: 'sieve://a', title: 'Auth Design' })
    expect(sink).toHaveBeenCalledWith({ uri: 'sieve://a', title: 'Auth Design' })
  })

  it('a DOCUMENT lens drops it — there the mention became a block', () => {
    class BareLens extends AbstractEditor {
      paint() {}
    }
    const note = new BareLens(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(note)
    expect(() => note.onMentionAccepted({ uri: 'sieve://a', title: 'x' })).not.toThrow()
  })
})

// The draft's menu makes two ASKS of whoever keeps the message — detach the
// document a token names, retire the draft. Both are asks and not acts: the lens
// holds neither the manifest nor the draft's lifetime, and the second retires
// the lens making it.
describe('the composer mount forwards the draft\'s two asks', () => {
  it('a detach ask travels with the title the token named', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    const sink = vi.fn()
    editor.onDetachRequest(sink)
    editor.requestDetach('Auth Design')
    expect(sink).toHaveBeenCalledWith('Auth Design')
  })

  it('a clear ask travels with nothing — retiring a draft has no argument', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    const sink = vi.fn()
    editor.onClearRequest(sink)
    editor.requestClear()
    expect(sink).toHaveBeenCalled()
  })

  it('unsubscribing stops both', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    const detach = vi.fn()
    const clear = vi.fn()
    editor.onDetachRequest(detach)()
    editor.onClearRequest(clear)()
    editor.requestDetach('Auth Design')
    editor.requestClear()
    expect(detach).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('a listener that throws does not stop the others — the same rule submit follows', () => {
    const editor = new ComposerEditor(Ident.mint(), { provider: new InMemoryContainerProvider() })
    built.push(editor)
    const after = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    editor.onClearRequest(() => { throw new Error('boom') })
    editor.onClearRequest(after)
    editor.requestClear()
    expect(after).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('the mount SUBSCRIBES to a headless lens without one — nothing to ask of nothing', () => {
    const mount = new ComposerMount(null)
    const sink = vi.fn()
    mount.onDetachRequest(sink)
    mount.onClearRequest(sink)
    expect(mount.open()).toBeNull()
    expect(sink).not.toHaveBeenCalled()
  })
})

// ── THE READINESS GATE FOR #102 ──────────────────────────────────────────────
//
// A composer-authored question list, sent through the EXISTING ask seam, must
// land as an ai-block whose `question` is what a hand-built #101 list is. The
// two are built by different gestures and must be the same value.
describe('a composer-authored question reaches the ask seam as a #101 question', () => {
  const CONTAINER = '9f2b1c4e-0000-7000-8000-000000000001'

  /** A lens with no surface, so askAi exercises the QUESTION BUILDING alone:
   *  what it hands createBlock is the whole of what is under test. */
  function askingLens(provider) {
    class BareLens extends AbstractEditor {
      paint() {}
    }
    const lens = new BareLens(CONTAINER, { provider })
    built.push(lens)
    return lens
  }

  function askFor(question, attachments) {
    const provider = new InMemoryContainerProvider({ uuid: CONTAINER })
    const added = vi.spyOn(provider, 'requestAddBlock')
    const lens = askingLens(provider)
    return lens
      .askAi({
        type: 'ask',
        question: question,
        context: { target: { kind: 'document', ref: 'doc', label: 'Document' }, blockIds: [] },
        attachments: attachments,
      })
      .then(() => added.mock.calls[0])
  }

  // THE COMPOSED PATH CARRIES ITS ATTACHMENTS IN THE LIST, because they are
  // blocks of the draft it harvested. The two-argument gesture below is the
  // SCALAR ask's — a note mount's ordinary question, which has no draft to hold
  // an element — and both must produce the same value.
  it('a harvested list carrying its own attachment IS the two-argument question', async () => {
    const harvested = ComposerMount.elementsOf(draftHolding(
      proseBlock('why does this panic?', 'blk-0'),
      attachmentBlock('sieve://other', 'Auth Design')))
    const [, composed] = await askFor(harvested, undefined)
    const [, scalar] = await askFor(
      [{ kind: 'prose', attrs: { id: 'blk-0', content: 'why does this panic?' } }],
      [{ uri: 'sieve://other', title: 'Auth Design' }])

    expect(composed.question).toEqual(scalar.question)
    expect(QuestionList.fold(composed.question, CONTAINER))
      .toEqual(QuestionList.fold(scalar.question, CONTAINER))
  })

  it('an attachment accepted MID-MESSAGE folds as an attachment — the list order is not the role', async () => {
    const harvested = ComposerMount.elementsOf(draftHolding(
      proseBlock('why does this panic?', 'blk-0'),
      attachmentBlock('sieve://other', 'Auth Design'),
      proseBlock('and what should it do?', 'blk-1')))
    const [, attrs] = await askFor(harvested, undefined)
    const slots = QuestionList.fold(attrs.question, CONTAINER)

    expect(slots.attachments)
      .toEqual([QuestionList.attachment('sieve://other', 'Auth Design')])
    expect(slots.body.map((/** @type {any} */ el) => el.attrs.content))
      .toEqual(['why does this panic?', 'and what should it do?'])
  })

  it('the composed path lands the same list a hand-built #101 question is', async () => {
    const [kind, attrs] = await askFor(
      [
        { kind: 'prose', attrs: { id: 'blk-0', content: 'why does this panic?' } },
        { kind: 'code', attrs: { id: 'blk-1', source: 'panic("x")', language: 'go' } },
      ],
      [{ uri: 'sieve://other', title: 'Auth Design' }])

    expect(kind).toBe('ai-block')
    expect(attrs.type).toBe('ASK')
    expect(attrs.question).toEqual([
      { kind: 'reference', attrs: { uri: 'sieve://' + CONTAINER, rel: QuestionRel.TARGET } },
      { kind: 'prose', attrs: { id: 'blk-0', content: 'why does this panic?' } },
      { kind: 'code', attrs: { id: 'blk-1', source: 'panic("x")', language: 'go' } },
      { kind: 'reference', attrs: { uri: 'sieve://other', rel: QuestionRel.ATTACH, cache: { title: 'Auth Design' } } },
    ])
  })

  it('GESTURE ORDER holds for the composed path: target first, body, then attachments', async () => {
    const [, attrs] = await askFor(
      [{ kind: 'prose', attrs: { id: 'b', content: 'q' } }],
      [{ uri: 'sieve://x', title: 'X' }])
    expect(attrs.question.map((/** @type {any} */ el) => el.attrs.rel || el.kind))
      .toEqual([QuestionRel.TARGET, 'prose', QuestionRel.ATTACH])
  })

  it('THE STRING PATH IS UNCHANGED: a one-line ask still mints the prose element itself', async () => {
    const [, attrs] = await askFor('why is the sky blue?', [])
    expect(attrs.question).toEqual([
      { kind: 'reference', attrs: { uri: 'sieve://' + CONTAINER, rel: QuestionRel.TARGET } },
      { kind: 'prose', attrs: { content: 'why is the sky blue?' } },
    ])
  })

  it('a composed single prose element and the string that wrote it FOLD alike', async () => {
    const [, composed] = await askFor([{ kind: 'prose', attrs: { content: 'q' } }], [])
    const [, typed] = await askFor('q', [])
    expect(QuestionList.fold(composed.question, CONTAINER))
      .toEqual(QuestionList.fold(typed.question, CONTAINER))
    expect(QuestionList.text(composed.question)).toBe(QuestionList.text(typed.question))
  })

  it('the harvested list travels VERBATIM — the builder invents nothing over it', async () => {
    const harvested = ComposerMount.elementsOf(
      draftOf('why does this panic?', '```go\npanic("x")\n```'))
    const [, attrs] = await askFor(harvested, [])
    expect(QuestionList.fold(attrs.question, CONTAINER).body).toEqual(harvested)
  })
})
