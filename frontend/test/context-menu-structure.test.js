// @ts-check
// context-menu-structure.test.js — the menu's STRUCTURED sections: the one-level
// flyout, the spelling corrections, the table verbs, and the fence's language.
//
// WHAT THE CARET IS IN IS RESOLVED FROM THE DOCUMENT. The sections appear off a
// resolved position's ancestors, never off the DOM under the pointer, so a doc
// built here — with no view and no layout — is enough to decide them.
//
// THE LANGUAGE LIST IS THE HIGHLIGHTER'S. It is read off the registry instance
// the app highlights with, so the stub here IS the assertion: the menu offers
// what the registry lists and nothing else.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'

const REGISTERED = ['python', 'go', 'javascript']

vi.mock('../src/static/renderers/highlighting.js', () => ({
  getLowlight: () => ({ listLanguages: () => REGISTERED }),
  listRegisteredLanguages: () => REGISTERED.slice().sort(),
  hastToHtml: () => '',
  applyHighlighting: () => {},
}))
vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', () => ({
  NodeViewRegistry: { extractContentEntryFromEditor: vi.fn(() => null) },
  detectAndAppendExtractions: vi.fn(),
  serializeNode: vi.fn(() => ''),
}))
vi.mock('../src/static/lens/document-editor/surfaces/prose-link.js', () => ({
  ProseLink: { forSelection: vi.fn(() => null) },
}))

// context-menu.js reaches lens/extensions.js, which builds its Extension.create()
// / PluginKey members at MODULE-EVAL time off the tiptap-vendor bag.
function makeProxy() {
  const fn = function () { return makeProxy() }
  fn.create = () => makeProxy()
  fn.extend = () => makeProxy()
  return new Proxy(fn, {
    apply() { return makeProxy() },
    construct() { return makeProxy() },
    get(t, prop) {
      if (prop in t) return t[prop]
      const child = makeProxy()
      t[prop] = child
      return child
    },
  })
}
const STUBBED_VENDOR_MEMBERS = [
  'Node', 'Extension', 'Plugin', 'PluginKey', 'Decoration', 'DecorationSet',
  'Highlight', 'markdownItMark', 'StarterKit', 'Placeholder', 'Table', 'TableRow',
  'TableHeader', 'TableCell', 'Image', 'TaskList', 'TaskItem', 'Markdown', 'Editor',
]

beforeAll(async () => {
  const stubs = {}
  for (const name of STUBBED_VENDOR_MEMBERS) stubs[name] = makeProxy()
  Object.assign(globalThis.TipTap, stubs)
  await import('../src/static/lens/document-editor/context-menu.js')
})

afterAll(() => {
  for (const name of STUBBED_VENDOR_MEMBERS) delete globalThis.TipTap[name]
})

afterEach(() => { document.getElementById('sieve-context-menu')?.remove() })

// A schema with the two structures the sections are about. Cells hold paragraphs
// so the caret sits three levels below the table, which is what the ancestor walk
// has to climb.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    table: { group: 'block', content: 'tableRow+', toDOM: () => ['table', ['tbody', 0]] },
    tableRow: { content: '(tableCell | tableHeader)+', toDOM: () => ['tr', 0] },
    tableCell: { content: 'paragraph+', toDOM: () => ['td', 0] },
    tableHeader: { content: 'paragraph+', toDOM: () => ['th', 0] },
    codeBlock: {
      group: 'block', content: 'text*', code: true,
      attrs: { language: { default: null } },
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { group: 'inline' },
  },
})

const n = schema.nodes

/** A doc holding one HEADERLESS table (plain `tableCell`s throughout), and a
 *  caret inside its first cell. */
function caretInTable() {
  const cell = n.tableCell.create(null, n.paragraph.create(null, schema.text('x')))
  const doc = n.doc.create(null, [n.table.create(null, n.tableRow.create(null, [cell]))])
  return stateWithCaret(doc, 4)
}

/** A doc holding one table whose first row is a real header row, and a caret
 *  inside its (second row) cell. */
function caretInTableWithHeader() {
  const header = n.tableHeader.create(null, n.paragraph.create(null, schema.text('h')))
  const cell = n.tableCell.create(null, n.paragraph.create(null, schema.text('x')))
  const doc = n.doc.create(null, [
    n.table.create(null, [n.tableRow.create(null, [header]), n.tableRow.create(null, [cell])]),
  ])
  return stateWithCaret(doc, 11)
}

/** A doc holding one fence, and a caret inside it. */
function caretInFence(language) {
  const doc = n.doc.create(null, [n.codeBlock.create({ language }, schema.text('code'))])
  return stateWithCaret(doc, 2)
}

/** A doc holding one paragraph, and a caret in it. */
function caretInProse() {
  return stateWithCaret(n.doc.create(null, [n.paragraph.create(null, schema.text('hello'))]), 2)
}

function stateWithCaret(doc, pos) {
  let state = EditorState.create({ schema, doc })
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos)))
}

/**
 * A pane over a real document, recording the commands a menu entry chains. The
 * menu is a caller of the pane's own verbs, so recording the chain IS the
 * assertion about what it does.
 */
function paneOver(state, host) {
  /** @type {string[]} */ const ran = []
  /** @type {any[]} */ const updates = []
  const chain = new Proxy({}, {
    get(_t, prop) {
      return (/** @type {any[]} */ ...args) => {
        if (prop === 'run') return true
        if (prop === 'updateAttributes') updates.push(args)
        else if (prop !== 'focus') ran.push(String(prop))
        return chain
      }
    },
  })
  return {
    ran,
    updates,
    sieveHost: host || null,
    state,
    view: { posAtCoords: () => null },
    isActive: () => false,
    chain: () => chain,
    commands: { focus: vi.fn(), selectAll: vi.fn(), setTextSelection: vi.fn() },
  }
}

/** Opens the editor context menu over `pane` and returns the live menu element. */
function openMenu(pane) {
  document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
    detail: { x: 10, y: 10, context: { type: 'editor', editor: pane } },
  }))
  return /** @type {HTMLElement} */ (document.getElementById('sieve-context-menu'))
}

/** The labels of ONE list — a menu's own items, not a flyout's.
 *  @param {HTMLElement} root @returns {string[]} */
function labelsOf(root) {
  return Array.from(root.children)
    .filter((el) => el.classList.contains('ctx-item'))
    .map((b) => b.textContent)
}

/** @param {HTMLElement} root @param {string} label @returns {HTMLElement} */
function itemNamed(root, label) {
  const found = Array.from(root.querySelectorAll('.ctx-item'))
    .find((b) => b.textContent.replace(/›$/, '') === label)
  if (!found) throw new Error('no menu item labelled ' + label + ' in [' + labelsOf(root) + ']')
  return /** @type {HTMLElement} */ (found)
}

/** @param {HTMLElement} parent the item carrying the flyout @returns {HTMLElement|null} */
function flyoutOf(parent) {
  return /** @type {HTMLElement} */ (parent.parentNode.querySelector('.sieve-context-submenu'))
}

const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

describe('the submenu primitive', () => {
  it('draws no flyout until the parent is reached', () => {
    const menu = openMenu(paneOver(caretInTable()))
    const row = itemNamed(menu, 'Row')
    expect(row.getAttribute('aria-haspopup')).toBe('true')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(flyoutOf(row)).toBeNull()
  })

  it('opens on hover, with its children in it', () => {
    const menu = openMenu(paneOver(caretInTable()))
    const row = itemNamed(menu, 'Row')
    row.dispatchEvent(new window.MouseEvent('mouseenter'))
    const flyout = flyoutOf(row)
    expect(flyout).not.toBeNull()
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(labelsOf(flyout)).toEqual(['Add Above', 'Add Below', 'Delete Row'])
  })

  it('STAYS OPEN when the pointer moves into it — a flyout is left for its own buttons', () => {
    const menu = openMenu(paneOver(caretInTable()))
    const row = itemNamed(menu, 'Row')
    row.dispatchEvent(new window.MouseEvent('mouseenter'))
    const child = itemNamed(flyoutOf(row), 'Add Above')
    // The pointer leaves the parent FOR a button inside the flyout, which is what
    // relatedTarget carries — never the flyout element itself.
    row.dispatchEvent(new window.MouseEvent('mouseleave', { relatedTarget: child }))
    expect(flyoutOf(row)).not.toBeNull()
  })

  // The hover path between the parent item and its flyout crosses a strip that
  // belongs to neither DOM element (CSS overlap narrows it, never removes it),
  // so a leave with a relatedTarget outside both must not close SYNCHRONOUSLY —
  // it arms a grace timer instead, giving the pointer time to land in the flyout.
  describe('the close grace period', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('leaves the flyout open through the grace window after leaving the parent', async () => {
      const menu = openMenu(paneOver(caretInTable()))
      const row = itemNamed(menu, 'Row')
      row.dispatchEvent(new window.MouseEvent('mouseenter'))
      row.dispatchEvent(new window.MouseEvent('mouseleave'))
      expect(flyoutOf(row)).not.toBeNull()
      await vi.advanceTimersByTimeAsync(100)
      expect(flyoutOf(row)).not.toBeNull()
    })

    it('closes once the grace window elapses with the pointer in neither', async () => {
      const menu = openMenu(paneOver(caretInTable()))
      const row = itemNamed(menu, 'Row')
      row.dispatchEvent(new window.MouseEvent('mouseenter'))
      row.dispatchEvent(new window.MouseEvent('mouseleave'))
      await vi.advanceTimersByTimeAsync(150)
      expect(flyoutOf(row)).toBeNull()
      expect(row.getAttribute('aria-expanded')).toBe('false')
    })

    it('cancels the pending close when the pointer reaches the flyout in time', async () => {
      const menu = openMenu(paneOver(caretInTable()))
      const row = itemNamed(menu, 'Row')
      row.dispatchEvent(new window.MouseEvent('mouseenter'))
      row.dispatchEvent(new window.MouseEvent('mouseleave'))
      const flyout = flyoutOf(row)
      flyout.dispatchEvent(new window.MouseEvent('mouseenter'))
      await vi.advanceTimersByTimeAsync(150)
      expect(flyoutOf(row)).not.toBeNull()
    })

    it('closes once the pointer then leaves the flyout too', async () => {
      const menu = openMenu(paneOver(caretInTable()))
      const row = itemNamed(menu, 'Row')
      row.dispatchEvent(new window.MouseEvent('mouseenter'))
      const flyout = flyoutOf(row)
      flyout.dispatchEvent(new window.MouseEvent('mouseenter'))
      flyout.dispatchEvent(new window.MouseEvent('mouseleave'))
      await vi.advanceTimersByTimeAsync(150)
      expect(flyoutOf(row)).toBeNull()
    })
  })

  it('opens on ArrowRight and puts focus on the first child', () => {
    const menu = openMenu(paneOver(caretInTable()))
    const row = itemNamed(menu, 'Row')
    key(row, 'ArrowRight')
    const flyout = flyoutOf(row)
    expect(flyout).not.toBeNull()
    expect(document.activeElement.textContent).toBe('Add Above')
  })

  it('moves within on Up/Down, wrapping at both ends', () => {
    const menu = openMenu(paneOver(caretInTable()))
    const row = itemNamed(menu, 'Row')
    key(row, 'ArrowRight')
    key(document.activeElement, 'ArrowDown')
    expect(document.activeElement.textContent).toBe('Add Below')
    key(document.activeElement, 'ArrowUp')
    key(document.activeElement, 'ArrowUp')
    expect(document.activeElement.textContent).toBe('Delete Row')
  })

  it('closes on ArrowLeft and hands focus back to the parent', () => {
    const menu = openMenu(paneOver(caretInTable()))
    const row = itemNamed(menu, 'Row')
    key(row, 'ArrowRight')
    key(document.activeElement, 'ArrowLeft')
    expect(flyoutOf(row)).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('accepting a child runs it and takes the WHOLE menu with it', () => {
    const pane = paneOver(caretInTable())
    const menu = openMenu(pane)
    const row = itemNamed(menu, 'Row')
    row.dispatchEvent(new window.MouseEvent('mouseenter'))
    itemNamed(flyoutOf(row), 'Add Below').click()
    expect(pane.ran).toEqual(['addRowAfter'])
    expect(document.getElementById('sieve-context-menu')).toBeNull()
  })
})

// The spelling section is the menu's only entry built from what the LENS
// advertises rather than from the document, so the lens stands in as a stub: it
// says which marks the caret sits on and records what it was asked to replace.
// Whether those marks resolve in the drawn document is settled in
// spell-marks.test.js — by the time one reaches an advertisement it has.

/** A stub document-editor lens advertising `marks` under the caret.
 *  @param {any[]} marks */
function spellingLens(marks) {
  const lens = {
    marks: marks,
    /** @type {any[]} */ replaced: [],
    getSelectionContext: () => ({ textMarks: lens.marks }),
    replaceText: (/** @type {any} */ mark, /** @type {string} */ word) => lens.replaced.push([mark, word]),
  }
  return lens
}

/** @param {string} quote @param {string[]} suggestions */
const spellMark = (quote, suggestions) => ({
  blockId: 'b1', locator: 'content', quote: quote, occurrence: 0,
  start: 0, end: quote.length, class: 'prose', suggestions: suggestions,
})

describe('the spelling section', () => {
  it('LEADS the menu, one entry per correction, closed by a separator', () => {
    const menu = openMenu(paneOver(caretInProse(), spellingLens([spellMark('teh', ['the', 'tea', 'ten'])])))
    expect(labelsOf(menu).slice(0, 3)).toEqual([
      "Replace with 'the'", "Replace with 'tea'", "Replace with 'ten'",
    ])
    expect(menu.children[3].classList.contains('ctx-separator')).toBe(true)
  })

  it('stands three in the menu and hangs the rest in the flyout', () => {
    const menu = openMenu(paneOver(caretInProse(), spellingLens([spellMark('teh', ['the', 'tea', 'ten', 'tec', 'ted'])])))
    expect(labelsOf(menu).filter((l) => l.startsWith('Replace with')).length).toBe(3)
    const more = itemNamed(menu, 'More suggestions')
    more.dispatchEvent(new window.MouseEvent('mouseenter'))
    expect(labelsOf(flyoutOf(more))).toEqual(["Replace with 'tec'", "Replace with 'ted'"])
  })

  it('offers no flyout when the menu already holds every correction', () => {
    const menu = openMenu(paneOver(caretInProse(), spellingLens([spellMark('teh', ['the', 'tea', 'ten'])])))
    expect(labelsOf(menu)).not.toContain('More suggestions›')
  })

  it('a correction taken from the flyout is the same verb, and closes the whole menu', () => {
    const lens = spellingLens([spellMark('teh', ['the', 'tea', 'ten', 'tec'])])
    const menu = openMenu(paneOver(caretInProse(), lens))
    const more = itemNamed(menu, 'More suggestions')
    more.dispatchEvent(new window.MouseEvent('mouseenter'))
    itemNamed(flyoutOf(more), "Replace with 'tec'").click()
    expect(lens.replaced).toEqual([[lens.marks[0], 'tec']])
    expect(document.getElementById('sieve-context-menu')).toBeNull()
  })

  it('asks the LENS to replace that mark with that word, and hands focus back', () => {
    const lens = spellingLens([spellMark('teh', ['the'])])
    const pane = paneOver(caretInProse(), lens)
    itemNamed(openMenu(pane), "Replace with 'the'").click()
    expect(lens.replaced).toEqual([[lens.marks[0], 'the']])
    expect(pane.commands.focus).toHaveBeenCalled()
  })

  it('speaks about the FIRST mark carrying corrections — the caret sits on one word', () => {
    const lens = spellingLens([spellMark('teh', []), spellMark('adn', ['and'])])
    const menu = openMenu(paneOver(caretInProse(), lens))
    expect(labelsOf(menu).filter((l) => l.startsWith('Replace with'))).toEqual(["Replace with 'and'"])
  })

  it('is absent where the caret sits on no mark, and offers no corrections where the mark carried none', () => {
    expect(labelsOf(openMenu(paneOver(caretInProse(), spellingLens([])))))
      .not.toContain("Replace with 'the'")
    expect(labelsOf(openMenu(paneOver(caretInProse(), spellingLens([spellMark('teh', [])])))).join(''))
      .not.toContain('Replace with')
  })

  it('is absent in a mount that advertises no marks at all — a bare pane', () => {
    expect(labelsOf(openMenu(paneOver(caretInProse()))).join('')).not.toContain('Replace with')
  })

  it('is absent where the mount cannot be written to this way', () => {
    const lens = spellingLens([spellMark('teh', ['the'])])
    delete lens.replaceText
    expect(labelsOf(openMenu(paneOver(caretInProse(), lens))).join('')).not.toContain('Replace with')
  })

  // Ignoring and learning are the WORKSPACE's verbs, not the lens's: a word
  // accepted here is accepted in every document open beside this one. The host
  // is reached the way every other workspace verb in this menu reaches it.
  it('offers Ignore and Add to dictionary, and hands the WORD to the workspace', () => {
    const spell = { ignored: /** @type {string[]} */ ([]), learned: /** @type {string[]} */ ([]),
      ignore(/** @type {string} */ w) { this.ignored.push(w) },
      learn(/** @type {string} */ w) { this.learned.push(w) } }
    const prevWs = window.sieveWorkspace
    window.sieveWorkspace = /** @type {any} */ ({ spell })
    try {
      const pane = paneOver(caretInProse(), spellingLens([spellMark('teh', ['the'])]))
      itemNamed(openMenu(pane), 'Ignore').click()
      itemNamed(openMenu(pane), 'Add to dictionary').click()
      expect(spell.ignored).toEqual(['teh'])
      expect(spell.learned).toEqual(['teh'])
    } finally { window.sieveWorkspace = prevWs }
  })

  // The mark nothing was close to is exactly the one a reader has an answer
  // for: it is not a word this dictionary knows, and they are saying it is.
  it('offers them for a mark carrying no corrections at all', () => {
    const labels = labelsOf(openMenu(paneOver(caretInProse(), spellingLens([spellMark('zzblorp', [])]))))
    expect(labels).toContain('Ignore')
    expect(labels).toContain('Add to dictionary')
    expect(labels.join('')).not.toContain('Replace with')
  })

  it('offers neither where the caret sits on no mark', () => {
    const labels = labelsOf(openMenu(paneOver(caretInProse(), spellingLens([]))))
    expect(labels).not.toContain('Ignore')
    expect(labels).not.toContain('Add to dictionary')
  })

  // A right-click on a squiggle the caret was NOT in must still be about that
  // word: the menu snaps the selection onto the pointer first, so the marks it
  // then reads are the ones under the pointer.
  it('reads the marks AFTER the right-click has moved the caret onto the word', () => {
    const lens = spellingLens([])
    const pane = paneOver(caretInProse(), lens)
    pane.view.posAtCoords = () => ({ pos: 4 })
    pane.commands.setTextSelection = vi.fn(() => { lens.marks = [spellMark('teh', ['the'])] })
    const menu = openMenu(pane)
    expect(pane.commands.setTextSelection).toHaveBeenCalledWith(4)
    expect(labelsOf(menu)).toContain("Replace with 'the'")
  })
})

describe('the table section', () => {
  it('is offered where the caret is inside a table', () => {
    const labels = labelsOf(openMenu(paneOver(caretInTable())))
    expect(labels).toContain('Row›')
    expect(labels).toContain('Column›')
    expect(labels).toContain('Delete Table')
  })

  it('is absent everywhere else', () => {
    const labels = labelsOf(openMenu(paneOver(caretInProse())))
    expect(labels).not.toContain('Row›')
    expect(labels).not.toContain('Delete Table')
  })

  it('runs the stock verbs, and the one Delete for a table is the named one', () => {
    const pane = paneOver(caretInTable())
    const menu = openMenu(pane)
    expect(labelsOf(menu)).not.toContain('Delete Block')
    itemNamed(menu, 'Delete Table').click()
    expect(pane.ran).toEqual(['deleteTable'])
  })

  it('offers the column verbs its own submenu holds', () => {
    const pane = paneOver(caretInTable())
    const menu = openMenu(pane)
    const column = itemNamed(menu, 'Column')
    column.dispatchEvent(new window.MouseEvent('mouseenter'))
    expect(labelsOf(flyoutOf(column))).toEqual(['Add Left', 'Add Right', 'Delete Column'])
    itemNamed(flyoutOf(column), 'Add Left').click()
    expect(pane.ran).toEqual(['addColumnBefore'])
  })

  // GFM pipe markdown requires a header row (#118): the OFF direction is gone,
  // so the entry exists only while the table has none, and never offers to
  // remove one that does.
  describe('Add Header Row', () => {
    it('is offered for a table with no header row, and runs toggleHeaderRow', () => {
      const pane = paneOver(caretInTable())
      const menu = openMenu(pane)
      expect(labelsOf(menu)).toContain('Add Header Row')
      itemNamed(menu, 'Add Header Row').click()
      expect(pane.ran).toEqual(['toggleHeaderRow'])
    })

    it('is absent for a table that already has one', () => {
      const labels = labelsOf(openMenu(paneOver(caretInTableWithHeader())))
      expect(labels).not.toContain('Add Header Row')
      expect(labels).not.toContain('Toggle Header Row')
    })
  })
})

// jsdom does no real layout: offsetTop never reflects a just-set style.top on
// its own, so it is shimmed here to derive from it — the one feedback loop a
// real browser gives placeSubmenu for free and this suite has to fake.
describe('the flyout placement', () => {
  /** @type {any} */ let originalOffsetTop

  beforeAll(() => {
    originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() { return parseFloat(this.style.top) || 0 },
    })
  })

  afterAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop)
  })

  it("keeps the flyout's bottom within the window when its parent sits near the bottom", () => {
    const pane = paneOver(caretInTable())
    const menu = openMenu(pane)
    const row = itemNamed(menu, 'Row')
    const menuTop = window.innerHeight - 40
    menu.getBoundingClientRect = () => /** @type {any} */ ({ top: menuTop, right: 200, width: 200 })
    Object.defineProperty(row, 'offsetTop', { value: 30, configurable: true })

    // A flyout far taller than the room left below menuTop — the degenerate
    // case a top-shift alone cannot fix (e.g. Language, with everything the
    // highlighter is registered for).
    const originalRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return this.classList && this.classList.contains('sieve-context-submenu')
        ? /** @type {any} */ ({ width: 150, height: 900 })
        : originalRect.call(this)
    }
    try {
      row.dispatchEvent(new window.MouseEvent('mouseenter'))
    } finally {
      Element.prototype.getBoundingClientRect = originalRect
    }

    const flyout = flyoutOf(row)
    expect(flyout.style.maxHeight).not.toBe('')
    const bottom = menuTop + parseFloat(flyout.style.top) + parseFloat(flyout.style.maxHeight)
    expect(bottom).toBeLessThanOrEqual(window.innerHeight)
  })
})

describe("the fence's language", () => {
  it('is offered inside a fence and nowhere else', () => {
    expect(labelsOf(openMenu(paneOver(caretInFence(null))))).toContain('Language›')
    expect(labelsOf(openMenu(paneOver(caretInProse())))).not.toContain('Language›')
  })

  it('lists what the highlighter is registered for, sorted, with Plain first', () => {
    const menu = openMenu(paneOver(caretInFence(null)))
    const language = itemNamed(menu, 'Language')
    language.dispatchEvent(new window.MouseEvent('mouseenter'))
    expect(labelsOf(flyoutOf(language))).toEqual(['Plain'].concat(REGISTERED.slice().sort()))
  })

  it('marks the fence\'s current language, and only that one', () => {
    const menu = openMenu(paneOver(caretInFence('go')))
    const language = itemNamed(menu, 'Language')
    language.dispatchEvent(new window.MouseEvent('mouseenter'))
    const active = Array.from(flyoutOf(language).querySelectorAll('.ctx-item--active'))
      .map((b) => b.textContent)
    expect(active).toEqual(['go'])
  })

  it('marks Plain when the fence carries no tag', () => {
    const menu = openMenu(paneOver(caretInFence(null)))
    const language = itemNamed(menu, 'Language')
    language.dispatchEvent(new window.MouseEvent('mouseenter'))
    const active = Array.from(flyoutOf(language).querySelectorAll('.ctx-item--active'))
      .map((b) => b.textContent)
    expect(active).toEqual(['Plain'])
  })

  it('sets the language as an attribute of the fence the caret is in', () => {
    const pane = paneOver(caretInFence(null))
    const menu = openMenu(pane)
    const language = itemNamed(menu, 'Language')
    language.dispatchEvent(new window.MouseEvent('mouseenter'))
    itemNamed(flyoutOf(language), 'go').click()
    expect(pane.updates).toEqual([['codeBlock', { language: 'go' }]])
  })

  // The end of the chain the harvest starts from: the language is a NODE
  // ATTRIBUTE, which is what a fence serializes its ```tag from and therefore
  // what `ComposerMount.harvest` reads back as a code element's `language`.
  it('lands on the real node when picked in a real editor', async () => {
    const { Editor } = await import('@tiptap/core')
    const { StarterKit } = await import('@tiptap/starter-kit')
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = new Editor({
      element: el,
      extensions: [StarterKit],
      content: '<pre><code>fmt.Println()</code></pre>',
    })
    editor.commands.setTextSelection(2)
    const menu = openMenu(editor)
    const language = itemNamed(menu, 'Language')
    language.dispatchEvent(new window.MouseEvent('mouseenter'))
    itemNamed(flyoutOf(language), 'go').click()
    expect(editor.state.doc.firstChild.type.name).toBe('codeBlock')
    expect(editor.state.doc.firstChild.attrs.language).toBe('go')
    editor.destroy()
    el.remove()
  })

  it('UNSETS it for Plain — the absence of a tag, not a language called Plain', () => {
    const pane = paneOver(caretInFence('go'))
    const menu = openMenu(pane)
    const language = itemNamed(menu, 'Language')
    language.dispatchEvent(new window.MouseEvent('mouseenter'))
    itemNamed(flyoutOf(language), 'Plain').click()
    expect(pane.updates).toEqual([['codeBlock', { language: null }]])
  })
})
