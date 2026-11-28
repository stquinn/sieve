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
import { ComposerEditor } from '../src/static/lens/document-editor/composer/composer-editor.js'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { NoteEditor } from '../src/static/lens/document-editor/note-editor.js'
import { EditorMode } from '../src/static/lens/document-editor/editor-mode.js'
import { InMemoryContainerProvider } from '../src/static/container/in-memory-container-provider.js'
import { QuestionList, QuestionRel } from '../src/static/renderers/question-list.js'
import { Ident } from '../src/static/ident/ident.js'
import { PanelPlacement } from '../src/static/shell/trigger-host.js'

// The owner modules that run vendor calls at IMPORT time and would crash under
// the bare test/setup.js TipTap seed. Nothing here mounts a surface.
vi.mock('../src/static/lens/extensions.js', () => ({
  SelectionHighlight: {}, HighlightMark: {},
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

describe('ComposerMount — the lens it opens', () => {
  it('hands the composer the PANEL placement, so its picker rises off the panel and not the caret', () => {
    // The lens is constructed for real; only its TipTap surface is stubbed out,
    // since the placement is fixed at construction, before any surface mounts.
    const present = vi.spyOn(ComposerEditor.prototype, 'presentSurface').mockImplementation(() => null)
    try {
      const mount = new ComposerMount(document.createElement('div'))
      const editor = mount.open()
      expect(editor).not.toBeNull()
      expect(/** @type {any} */ (editor).triggerPlacement).toBeInstanceOf(PanelPlacement)
      mount.destroy()
    } finally { present.mockRestore() }
  })
})

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

// ── A QUOTE GOES INTO THE DRAFT AS A BLOCK, AFTER THE CARET'S BLOCK ─────────
//
// The draft is a list of blocks, and a quote is one of them: it goes in after
// the block the caret is in, or last with no caret in the draft, and the
// harvest carries it where it is, with its attrs, like any other element.
describe('ComposerMount — a quote put into the draft', () => {
  beforeEach(() => { vi.spyOn(ComposerEditor.prototype, 'presentSurface').mockImplementation(() => /** @type {any} */ (null)) })
  afterEach(() => { vi.restoreAllMocks() })

  const CHAT = '0198c1a0-0000-7000-8000-0000000000c1'
  /** @param {string} text */
  const quote = (text) => /** @type {any} */ (QuestionList.quotation(CHAT, '0198c1a0-0000-7000-8000-0000000000e1', text))

  /** A mount whose draft holds `contents` as prose blocks blk-0…, with the caret
   *  in the block named `caret` (null: in none). @param {string|null} caret @param {...string} contents */
  function drafted(caret, ...contents) {
    const mount = new ComposerMount(document.createElement('div'))
    const editor = /** @type {ComposerEditor} */ (mount.open())
    const provider = /** @type {InMemoryContainerProvider} */ (mount.provider)
    contents.forEach((content, i) => provider.requestAddBlock('prose', { id: 'blk-' + i, content }))
    vi.spyOn(editor, 'getSelectionContext').mockReturnValue(/** @type {any} */ ({ blockId: caret }))
    return mount
  }

  /** @param {ComposerMount} mount @returns {string[]} the harvest, a prose block as its text, a quote as its quote */
  const said = (mount) => mount.harvest().map((e) => e.kind === 'prose' ? e.attrs.content : '> ' + e.attrs.cache.quote)

  it.each([
    ['after the block the caret is in', 'blk-0', ['one', '> q', 'two']],
    ['after the last block when the caret is in it', 'blk-1', ['one', 'two', '> q']],
    ['last when the caret is in no block of the draft', null, ['one', 'two', '> q']],
    ['last when the caret names a block the draft does not hold', 'gone', ['one', 'two', '> q']],
  ])('goes in %s', (_name, caret, harvested) => {
    const mount = drafted(caret, 'one', 'two')
    mount.insert(quote('q'))
    expect(said(mount)).toEqual(harvested)
    mount.destroy()
  })

  // An empty paragraph is where writing goes on, so a quote goes in ABOVE it: no
  // empty line is left over the quote, in an empty draft above all.
  it.each([
    ['an empty draft\'s one paragraph', 'blk-0', [''], ['> q', '']],
    ['an empty paragraph under text', 'blk-1', ['one', ''], ['one', '> q', '']],
    ['an empty paragraph between text', 'blk-1', ['one', '  ', 'two'], ['one', '> q', '  ', 'two']],
  ])('goes in before the caret\'s block when it is %s', (_name, caret, contents, held) => {
    const mount = drafted(caret, ...contents)
    mount.insert(quote('q'))
    const provider = /** @type {InMemoryContainerProvider} */ (mount.provider)
    const blocks = provider.getOrder().map((id) => /** @type {any} */ (provider.getBlock(id)))
    expect(blocks.map((b) => b.kind === 'prose' ? b.attrs.content : '> ' + b.attrs.cache.quote)).toEqual(held)
    mount.destroy()
  })

  it('travels in the harvest as the reference it is, its attrs whole and named by the draft', () => {
    const mount = drafted(null, 'why?')
    mount.insert(quote('the scanner trims'))
    const [, element] = mount.harvest()
    const { id, ...attrs } = element.attrs
    expect(element.kind).toBe('reference')
    expect(attrs).toEqual(quote('the scanner trims').attrs)
    expect(Ident.valid(id)).toBe(true)
    mount.destroy()
  })

  it('two quotes are two blocks, each where it was put; deleting one leaves the other', () => {
    const mount = drafted('blk-0', 'one')
    mount.insert(quote('first'))
    mount.insert(quote('second'))
    expect(said(mount)).toEqual(['one', '> second', '> first'])
    const provider = /** @type {InMemoryContainerProvider} */ (mount.provider)
    const [, second] = provider.getOrder()
    provider.requestRemoveBlock(second)
    expect(said(mount)).toEqual(['one', '> first'])
    mount.destroy()
  })

  it('is a change of the draft: its listeners hear it', () => {
    const mount = drafted(null)
    const changed = vi.fn()
    mount.onChanged(changed)
    mount.insert(quote('q'))
    expect(changed).toHaveBeenCalledTimes(1)
    mount.destroy()
  })

  it('a draft holding only a quote is not empty: Up is the caret\'s in it', () => {
    window.isMod = (e) => !!(e.ctrlKey || e.metaKey)
    const mount = drafted(null)
    mount.recallFrom(() => [[{ kind: 'prose', attrs: { content: 'asked' } }]])
    mount.insert(quote('q'))
    expect(/** @type {ComposerEditor} */ (mount.editor).claimKey(A_KEY('ArrowUp'))).toBe(false)
    mount.destroy()
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

// ── A DRAFT BELONGS TO A PLACE, AND UP RECALLS WHAT ITS SOURCE SAYS WAS ASKED ─
//
// Driven through the draft container and the lens's own `claimKey`, which puts
// a bare Up or Down to the mount: the surface is stubbed, so what is written is
// written into the container, as the lens's observer would write it. What is
// recalled is whatever the source the host named answers at the key; the mount
// keeps nothing of what was sent.
describe('ComposerMount — drafts by place, and Up recalling what was asked', () => {
  beforeEach(() => {
    window.isMod = (e) => !!(e.ctrlKey || e.metaKey)
    vi.spyOn(ComposerEditor.prototype, 'presentSurface').mockImplementation(() => /** @type {any} */ (null))
  })
  afterEach(() => { vi.restoreAllMocks() })

  /** @param {string} content */
  const asked = (content) => Object.freeze([Object.freeze({ kind: 'prose', attrs: Object.freeze({ id: Ident.mint(), content }) })])

  /** A mount with its draft open, recalling from a source that answers
   *  `questions` as they stand at each key.
   *  @param {...string} questions @returns {{mount: ComposerMount, questions: any[], source: any}} */
  function opened(...questions) {
    const mount = new ComposerMount(document.createElement('div'))
    const list = questions.map(asked)
    const source = vi.fn(() => list)
    mount.recallFrom(source)
    mount.open()
    return { mount, questions: list, source }
  }

  /** @param {ComposerMount} mount @param {string} content */
  const write = (mount, content) => /** @type {InMemoryContainerProvider} */ (mount.provider).requestAddBlock('prose', { content })

  /** @param {ComposerMount} mount @returns {string} the draft, one entry per block */
  const draft = (mount) => ComposerMount.elementsOf(/** @type {InMemoryContainerProvider} */ (mount.provider))
    .map((e) => e.attrs.content || e.kind).join('|')

  /** @param {ComposerMount} mount @param {string} key @param {object} [mods] @returns {boolean} claimed */
  const press = (mount, key, mods) => /** @type {ComposerEditor} */ (mount.editor).claimKey(A_KEY(key, mods))

  it('each place keeps its own draft, and the place returned to presents it again', () => {
    const { mount } = opened()
    write(mount, 'about the note')
    mount.setPlace('chat-a')
    mount.open()
    expect(draft(mount)).toBe('')
    write(mount, 'to chat a')
    mount.setPlace('chat-b')
    mount.open()
    write(mount, 'to chat b')
    mount.setPlace('')
    expect(draft(mount)).toBe('about the note')
    mount.setPlace('chat-a')
    expect(draft(mount)).toBe('to chat a')
    mount.forget('chat-a')
    mount.open()
    expect(draft(mount)).toBe('')
    mount.setPlace('chat-b')
    expect(draft(mount)).toBe('to chat b')
    mount.destroy()
  })

  it.each([
    ['Up recalls the last asked', ['ArrowUp'], [true], 'two'],
    ['Up again goes further back', ['ArrowUp', 'ArrowUp'], [true, true], 'one'],
    ['Up on the oldest is claimed and stays there', ['ArrowUp', 'ArrowUp', 'ArrowUp'], [true, true, true], 'one'],
    ['Down comes forward', ['ArrowUp', 'ArrowUp', 'ArrowDown'], [true, true, true], 'two'],
    ['Down past the newest returns to an empty draft', ['ArrowUp', 'ArrowDown'], [true, true], ''],
    ['Down in an empty draft is not claimed', ['ArrowUp', 'ArrowDown', 'ArrowDown'], [true, true, false], ''],
    ['Down with nothing recalled is not claimed', ['ArrowDown'], [false], ''],
  ])('in an empty draft: %s', (_name, keys, claimed, after) => {
    const { mount } = opened('one', 'two')
    expect(keys.map((key) => press(mount, key))).toEqual(claimed)
    expect(draft(mount)).toBe(after)
    mount.destroy()
  })

  it.each([
    ['a mount told of no source', () => new ComposerMount(document.createElement('div'))],
    ['a source with nothing asked', () => opened().mount],
  ])('Up recalls nothing and is not claimed with %s', (_name, make) => {
    const mount = make()
    mount.open()
    expect([press(mount, 'ArrowUp'), draft(mount)]).toEqual([false, ''])
    mount.destroy()
  })

  it.each([
    ['a draft with words in it', (/** @type {ComposerMount} */ m) => write(m, 'half a question')],
    ['a draft holding only an attachment', (/** @type {ComposerMount} */ m) => {
      const { kind, attrs } = attachmentBlock('sieve://other', 'Auth Design')
      const provider = /** @type {InMemoryContainerProvider} */ (m.provider)
      provider.requestAddBlock(kind, attrs)
    }],
  ])('Up and Down are the caret\'s in %s: never claimed, the draft untouched, the source not read', (_name, fill) => {
    const { mount, source } = opened('one')
    fill(mount)
    const before = draft(mount)
    expect([press(mount, 'ArrowUp'), press(mount, 'ArrowDown')]).toEqual([false, false])
    expect(draft(mount)).toBe(before)
    expect(source).not.toHaveBeenCalled()
    mount.destroy()
  })

  it.each([['Shift', { shiftKey: true }], ['Alt', { altKey: true }], ['Ctrl', { ctrlKey: true }], ['Cmd', { metaKey: true }]])(
    '%s+Up recalls nothing', (_name, mods) => {
      const { mount } = opened('one')
      expect(press(mount, 'ArrowUp', mods)).toBe(false)
      expect(draft(mount)).toBe('')
      mount.destroy()
    })

  it('the source is read at the key: a question asked since the last Up is the first recalled', () => {
    const { mount, questions } = opened('one')
    expect([press(mount, 'ArrowUp'), draft(mount)]).toEqual([true, 'one'])
    press(mount, 'ArrowDown')
    questions.push(asked('just now'))
    expect([press(mount, 'ArrowUp'), draft(mount)]).toEqual([true, 'just now'])
    expect([press(mount, 'ArrowUp'), draft(mount)]).toEqual([true, 'one'])
    mount.destroy()
  })

  it('a recalled question that is edited is the draft: Up is the caret\'s again', () => {
    const { mount } = opened('one', 'two')
    press(mount, 'ArrowUp')
    write(mount, 'and more')
    expect(press(mount, 'ArrowUp')).toBe(false)
    expect(draft(mount)).toBe('two|and more')
    mount.destroy()
  })

  it('a recalled question is a new draft: its blocks are named afresh, never with the ids they were asked with', () => {
    const { mount, questions } = opened('one')
    press(mount, 'ArrowUp')
    const provider = /** @type {InMemoryContainerProvider} */ (mount.provider)
    const [id] = provider.getOrder()
    expect(provider.getBlock(id)?.attrs.id).toBe(id)
    expect(id).not.toBe(questions[0][0].attrs.id)
    press(mount, 'ArrowDown')
    press(mount, 'ArrowUp')
    expect(/** @type {InMemoryContainerProvider} */ (mount.provider).getOrder()[0]).not.toBe(id)
    mount.destroy()
  })

  it('sending retires the draft and records nothing: Up recalls only what the source answers', () => {
    const { mount } = opened()
    write(mount, 'sent')
    mount.reset()
    expect([press(mount, 'ArrowUp'), draft(mount)]).toEqual([false, ''])
    mount.destroy()
  })

  it('a recall is a change of the draft: its listeners hear it', () => {
    const { mount } = opened('one')
    const changed = vi.fn()
    mount.onChanged(changed)
    press(mount, 'ArrowUp')
    expect(changed).toHaveBeenCalledTimes(1)
    mount.destroy()
  })
})

// ── A RECALLED QUESTION COMES BACK WHOLE ─────────────────────────────────────
//
// `blocksOf` is the walk's inverse: what it writes into a draft is what the
// harvest reads back out of it, each element as it was asked, a quote and an
// attachment included; a kind a draft cannot hold is left out.
describe('ComposerMount.blocksOf — a question written back as a draft', () => {
  const CHAT = '0198c1a0-0000-7000-8000-0000000000c1'
  const quote = /** @type {any} */ (QuestionList.quotation(CHAT, '0198c1a0-0000-7000-8000-0000000000e1', 'the scanner trims'))
  const attachment = /** @type {any} */ (QuestionList.attachment('sieve://0198c1a0-0002-7000-8000-0000000000f1', 'Auth Design'))

  /** @param {any[]} elements @returns {any[]} the harvest of a draft holding them, ids aside */
  const roundTrip = (elements) => ComposerMount.elementsOf(new InMemoryContainerProvider({
    blocks: ComposerMount.blocksOf(elements).map((block, i) => ({ id: 'blk-' + i, kind: block.kind, attrs: Object.assign({}, block.attrs, { id: 'blk-' + i }) })),
  })).map(({ kind, attrs: { id: _id, ...attrs } }) => ({ kind, attrs }))

  it.each([
    ['prose', [{ kind: 'prose', attrs: { id: 'x', content: 'why?' } }], [{ kind: 'prose', attrs: { content: 'why?' } }]],
    ['code, as the fence it is harvested from', [{ kind: 'code', attrs: { source: 'panic()', language: 'go' } }], [{ kind: 'code', attrs: { source: 'panic()', language: 'go' } }]],
    ['a quote and an attachment, in place', [quote, { kind: 'prose', attrs: { content: 'why @Auth Design?' } }, attachment],
      [quote, { kind: 'prose', attrs: { content: 'why @Auth Design?' } }, attachment]],
    ['a kind a draft cannot hold, left out', [{ kind: 'prose', attrs: { content: 'see' } }, { kind: 'diagram', attrs: { source: 'a -> b' } }],
      [{ kind: 'prose', attrs: { content: 'see' } }]],
  ])('%s', (_name, elements, harvested) => {
    expect(roundTrip(elements)).toEqual(harvested)
  })

  it('a recalled question with a quote and an attachment is presented with both', () => {
    window.isMod = (e) => !!(e.ctrlKey || e.metaKey)
    const present = vi.spyOn(ComposerEditor.prototype, 'presentSurface').mockImplementation(() => /** @type {any} */ (null))
    try {
      const mount = new ComposerMount(document.createElement('div'))
      mount.recallFrom(() => [QuestionList.written([quote, { kind: 'prose', attrs: { content: 'why @Auth Design?' } }, attachment])])
      mount.open()
      expect(/** @type {ComposerEditor} */ (mount.editor).claimKey(A_KEY('ArrowUp'))).toBe(true)
      const provider = /** @type {InMemoryContainerProvider} */ (mount.provider)
      const blocks = provider.getOrder().map((id) => /** @type {any} */ (provider.getBlock(id)))
      expect(blocks.map((b) => b.kind)).toEqual(['reference', 'prose', 'reference'])
      expect(blocks[0].attrs.displayAs).toBe('quote')
      expect(QuestionList.attachmentOf(blocks[2])).toEqual({ uri: attachment.attrs.uri, title: 'Auth Design' })
      mount.destroy()
    } finally { present.mockRestore() }
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

  it('claims NOTHING else without a host that recalls — every other key falls through to the surface', () => {
    const editor = composer()
    for (const key of ['Escape', 'Tab', 'a', 'Backspace', 'ArrowUp', 'ArrowDown', 'Home']) {
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
    class BareLens extends NoteEditor {
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
