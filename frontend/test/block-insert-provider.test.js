// @ts-check
// block-insert-provider.test.js — the `{` trigger (#91): the THIRD provider, and
// the first whose acceptance is not a text substitution.
//
// What it pins is the two halves the base class defines: the SCAN (`{` opens at
// a boundary, its token ends at whitespace — both inherited defaults, asserted
// through the real scanner) and ACCEPTANCE (the entry is asked to run against
// the host). A host that records its calls proves the second half, for both
// shapes an entry takes: a BlockMacro hands the host the token to delete and a
// kind to create, an ActionMacro clears the token itself and then calls a verb.
import { describe, it, expect, vi } from 'vitest'
import {
  TriggerProvider, SlashCommandProvider, BlockInsertProvider, Macro, BlockMacro, ActionMacro,
  SUBGRID_ROWS,
} from '../src/static/shell/trigger-providers.js'
import { TriggerHost } from '../src/static/shell/trigger-host.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { LensCapability } from '../src/static/contract/lens-capabilities.js'

const KINDS = [
  { kind: 'code', label: 'Code', description: 'Source, syntax-highlighted', icon: '<svg id="code-icon"></svg>', defaults: {} },
  { kind: 'diagram', label: 'Diagram', description: 'Mermaid or PlantUML', icon: '', defaults: {} },
  { kind: 'log', label: 'Log', description: 'Log output, parsed', icon: '', defaults: {} },
  { kind: 'web-clip', label: 'Clipping', description: 'A captured page', icon: '', defaults: { mode: 'article' } },
]

/** The verb entry the workspace contributes, as an ActionMacro. */
function tableMacro(action = () => {}) {
  return new ActionMacro({
    label: 'Table', name: 'table', description: '3×3 with a header row',
    requires: LensCapability.MARKDOWN, action,
  })
}

/** The Fence preset's shape (#118 bonus): an ActionMacro whose action reads the
 *  token's argument tail — `{fence:go` — as the language. */
function fenceMacro(action = () => {}) {
  return new ActionMacro({
    label: 'Fence', name: 'fence', description: 'A fenced code block',
    requires: LensCapability.MARKDOWN, action,
  })
}

/** A lister handing out fresh entries, as the catalog's does. */
const lister = { list: () => KINDS.map((k) => new BlockMacro(k)) }

/** @param {any[]} [extra] @returns {BlockInsertProvider} */
function provider(extra) {
  return new BlockInsertProvider({ list: () => lister.list().concat(extra || []) })
}

/** @returns {Map<string, TriggerProvider>} */
function providers() { return new Map([['{', provider()]]) }

/**
 * A document host: it can hold a block, and it RECORDS rather than acts. Both
 * facilities are present, so which one an entry reaches for is the assertion.
 */
class RecordingDocumentHost extends TriggerHost {
  constructor() {
    super()
    /** @type {Array<{kind: string, attrs: any, token: any}>} */ this.created = []
    /** @type {any[]} */ this.textCalls = []
  }

  anchorElement() { return document.body }
  onKeyDown() { return () => {} }
  onDismiss() { return () => {} }
  createBlock(kind, attrs, token) { this.created.push({ kind, attrs, token }) }
  textAfter(index) { this.textCalls.push(['textAfter', index]); return '' }
  replaceRange(start, end, text) { this.textCalls.push(['replaceRange', start, end, text]) }
}

/** A composer-shaped host: text only, no block to create. */
class TextOnlyHost extends TriggerHost {
  anchorElement() { return document.body }
  onKeyDown() { return () => {} }
  onDismiss() { return () => {} }
}

describe('BlockInsertProvider — construction', () => {
  it('claims the `{` trigger', () => {
    expect(provider().trigger).toBe('{')
  })

  it('refuses to be built without a macro lister', () => {
    expect(() => new BlockInsertProvider(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new BlockInsertProvider(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })
})

describe('BlockInsertProvider — the token under the caret', () => {
  it('opens at the start of the text', () => {
    const token = TriggerProvider.scanToken('{co', 3, providers())
    expect(token?.prefix).toBe('co')
    expect(token?.start).toBe(0)
    expect(token?.end).toBe(3)
    expect(token?.provider.trigger).toBe('{')
  })

  it('opens after whitespace, mid-line', () => {
    const token = TriggerProvider.scanToken('then {dia', 9, providers())
    expect(token?.prefix).toBe('dia')
    expect(token?.start).toBe(5)
  })

  it('refuses a `{` glued to a word — that is a literal brace, not an insert', () => {
    expect(TriggerProvider.scanToken('${code', 6, providers())).toBeNull()
    expect(TriggerProvider.scanToken('fn(){', 5, providers())).toBeNull()
  })

  it('ends the token at the first whitespace — a macro is named in one word', () => {
    expect(TriggerProvider.scanToken('{code and more', 14, providers())).toBeNull()
  })

  it('takes the `{` NEAREST the caret', () => {
    const token = TriggerProvider.scanToken('{code {log', 10, providers())
    expect(token?.prefix).toBe('log')
    expect(token?.start).toBe(6)
  })
})

describe('BlockInsertProvider — search', () => {
  it('lists everything for a bare `{` — that is the browse gesture', () => {
    expect(provider().search('').map((m) => m.name)).toEqual(['code', 'diagram', 'log', 'web-clip'])
  })

  it('filters by label, case-insensitively', () => {
    expect(provider().search('co').map((m) => m.name)).toEqual(['code'])
    expect(provider().search('CODE').map((m) => m.name)).toEqual(['code'])
    expect(provider().search('Di').map((m) => m.name)).toEqual(['diagram'])
  })

  it('filters by the SECONDARY name too, so a kind is findable by what it is called on the wire', () => {
    expect(provider().search('web').map((m) => m.name)).toEqual(['web-clip'])
  })

  it('offers a verb macro beside the kinds, filtered by the same two words', () => {
    expect(provider([tableMacro()]).search('').map((m) => m.name)).toEqual(['code', 'diagram', 'log', 'web-clip', 'table'])
    expect(provider([tableMacro()]).search('tab').map((m) => m.label)).toEqual(['Table'])
  })

  it('answers an unknown prefix with nothing', () => {
    expect(provider().search('zzz')).toEqual([])
  })

  it('answers synchronously — the vocabulary is local', () => {
    expect(Array.isArray(provider().search('co'))).toBe(true)
  })

  // THE ARGUMENT SEPARATOR (#118 bonus): `{fence:go` is one token under the
  // scanner's own default rules (`:` is not whitespace, so acceptsPrefix needs
  // no override), and matching stays HEAD-ONLY — the argument tail plays no
  // part in finding the entry, only in what it is handed at accept().
  describe('the `:` argument separator — matching stops at the head', () => {
    it('matches the exact head, ignoring everything past the separator', () => {
      expect(provider([fenceMacro()]).search('fence:go').map((m) => m.name)).toEqual(['fence'])
    })

    it('matches an UNAMBIGUOUS PARTIAL head exactly as an ordinary prefix would', () => {
      expect(provider([fenceMacro()]).search('fen:go').map((m) => m.name)).toEqual(['fence'])
    })

    it('matches down to a single unambiguous letter — the separator changes nothing about matching', () => {
      expect(provider([fenceMacro()]).search('f:go').map((m) => m.name)).toEqual(['fence'])
    })

    it('an EMPTY head before the separator lists everything, same as a bare `{`', () => {
      expect(provider([fenceMacro()]).search(':go').map((m) => m.name).sort())
        .toEqual(['code', 'diagram', 'fence', 'log', 'web-clip'].sort())
    })
  })
})

describe('BlockInsertProvider — acceptance RUNS THE ENTRY', () => {
  it('creates the chosen kind with its defaults, handing the host the ORIGINAL token', () => {
    const host = new RecordingDocumentHost()
    const p = provider()
    const item = p.search('web')[0]
    const token = Object.freeze({ provider: p, start: 4, end: 8, prefix: 'web' })

    p.accept(item, token, /** @type {any} */ (host))

    expect(host.created).toEqual([{ kind: 'web-clip', attrs: { mode: 'article' }, token }])
    expect(host.created[0].token).toBe(token)
  })

  it('hands the host a FRESH attrs object — the create path enriches what it is given', () => {
    const host = new RecordingDocumentHost()
    const p = provider()
    const item = p.search('web')[0]
    const token = Object.freeze({ provider: p, start: 4, end: 8, prefix: 'web' })

    p.accept(item, token, /** @type {any} */ (host))
    host.created[0].attrs.language = 'go'
    p.accept(item, token, /** @type {any} */ (host))

    expect(host.created[1].attrs).toEqual({ mode: 'article' })
  })

  it('writes no text for a kind — deleting the token is the HOST\'s half of the job', () => {
    const host = new RecordingDocumentHost()
    const p = provider()
    p.accept(p.search('co')[0], Object.freeze({ provider: p, start: 0, end: 3, prefix: 'co' }), /** @type {any} */ (host))
    expect(host.textCalls).toEqual([])
  })

  it('refuses a host that cannot hold a block', () => {
    const p = provider()
    const token = Object.freeze({ provider: p, start: 0, end: 3, prefix: 'co' })
    expect(() => p.accept(p.search('co')[0], token, new TextOnlyHost())).toThrow(ContractViolation)
  })

  it('clears the token BEFORE running a verb, and creates nothing', () => {
    const host = new RecordingDocumentHost()
    const action = vi.fn(() => { expect(host.textCalls).toEqual([['replaceRange', 2, 6, '']]) })
    const p = provider([tableMacro(action)])
    const token = Object.freeze({ provider: p, start: 2, end: 6, prefix: 'tab' })

    p.accept(p.search('tab')[0], token, /** @type {any} */ (host))

    expect(action).toHaveBeenCalledTimes(1)
    expect(host.created).toEqual([])
  })

  it('refuses a verb a host cannot be typed into', () => {
    const p = provider([tableMacro()])
    const token = Object.freeze({ provider: p, start: 0, end: 4, prefix: 'tab' })
    expect(() => p.accept(p.search('tab')[0], token, new TextOnlyHost())).toThrow(ContractViolation)
  })

  // THE TOKEN'S ARGUMENT TAIL (#118 bonus) — read off the LIVE token at accept
  // time, not off the candidate that matched it, so a partial-head match still
  // carries the full typed argument.
  describe('the argument tail travels to run()', () => {
    it('carries the tail after `:`, even reached via a PARTIAL head match', () => {
      const host = new RecordingDocumentHost()
      const action = vi.fn()
      const p = provider([fenceMacro(action)])
      const item = p.search('fen:go')[0]
      const token = Object.freeze({ provider: p, start: 0, end: 7, prefix: 'fen:go' })

      p.accept(item, token, /** @type {any} */ (host))

      expect(action).toHaveBeenCalledWith('go')
    })

    it('is undefined when the token carries no separator at all', () => {
      const host = new RecordingDocumentHost()
      const action = vi.fn()
      const p = provider([fenceMacro(action)])
      const item = p.search('fence')[0]
      const token = Object.freeze({ provider: p, start: 0, end: 6, prefix: 'fence' })

      p.accept(item, token, /** @type {any} */ (host))

      expect(action).toHaveBeenCalledWith(undefined)
    })

    it('is an empty string when the separator was typed with nothing after it', () => {
      const host = new RecordingDocumentHost()
      const action = vi.fn()
      const p = provider([fenceMacro(action)])
      const item = p.search('fence:')[0]
      const token = Object.freeze({ provider: p, start: 0, end: 7, prefix: 'fence:' })

      p.accept(item, token, /** @type {any} */ (host))

      expect(action).toHaveBeenCalledWith('')
    })

    it('is ignored by a BlockMacro kind entry — a kind takes no argument, and nothing breaks carrying one anyway', () => {
      const host = new RecordingDocumentHost()
      const p = provider()
      const item = p.search('web')[0]
      const token = Object.freeze({ provider: p, start: 0, end: 8, prefix: 'web:clip' })

      p.accept(item, token, /** @type {any} */ (host))

      expect(host.created).toEqual([{ kind: 'web-clip', attrs: { mode: 'article' }, token }])
    })
  })
})

describe('Macro — the entry contract', () => {
  it('is abstract: a bare Macro cannot be run', () => {
    expect(() => new Macro({ label: 'Nothing', requires: LensCapability.BLOCKS }).run(/** @type {any} */ (null), /** @type {any} */ (null)))
      .toThrow(ContractViolation)
  })

  it('demands a label — an entry nobody can read is not an offer', () => {
    expect(() => new Macro(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('answers to its label when it declares no second name', () => {
    expect(new Macro({ label: 'Table', requires: LensCapability.MARKDOWN }).name).toBe('Table')
  })

  it('refuses an ActionMacro with nothing to run', () => {
    expect(() => new ActionMacro(/** @type {any} */ ({ label: 'Table', requires: LensCapability.MARKDOWN })))
      .toThrow(ContractViolation)
  })
})

describe('BlockInsertProvider — the row', () => {
  it('draws the house row: the entry\'s name and what it is', () => {
    const el = row(provider().search('co')[0])
    expect(el.querySelector('.command-hint__name')?.textContent).toBe('Code')
    expect(el.querySelector('.command-hint__desc')?.textContent).toBe('Source, syntax-highlighted')
  })

  it('fills the icon slot when the entry has one', () => {
    expect(row(provider().search('co')[0]).querySelector('#code-icon')).not.toBeNull()
  })
})

// THE ROW IS A SET OF COLUMNS, and the columns are the whole point: a picker's
// rows must break at the same x positions down the list, so the eye reads names
// as one column and descriptions as another. Two things make that true and both
// are asserted here. WHERE A PROVIDER DECLARES AN ICON COLUMN, EVERY ROW CARRIES
// THE SLOT — empty or not — so an icon-less entry's name still starts where an
// iconed one's does. THE NAME SLOT HAS A FLOOR WIDTH — so descriptions begin at
// a shared x rather than hugging whatever name precedes them.
//
// This replaces the `justify-content: space-between` the popover used to lay the
// row out with, which right-anchored every description against a ragged left
// edge and floated any third child in the middle of the row.
describe('the house row — the picker\'s columns', () => {
  it('emits icon, name and description for a provider that declares an icon column', () => {
    expect(provider().providesIcons).toBe(true)
    expect(slots(row(provider().search('co')[0])))
      .toEqual(['command-hint__icon', 'command-hint__name', 'command-hint__desc'])
  })

  it('keeps the icon slot present-but-EMPTY when an entry has no icon of its own', () => {
    const el = row(provider().search('log')[0])
    const icon = /** @type {HTMLElement} */ (el.querySelector('.command-hint__icon'))
    expect(icon).not.toBeNull()
    expect(icon.innerHTML).toBe('')
  })

  it('reserves the same icon gutter whether the entry has an icon or not', () => {
    const iconed = /** @type {HTMLElement} */ (row(provider().search('co')[0]).querySelector('.command-hint__icon'))
    const plain = /** @type {HTMLElement} */ (row(provider().search('log')[0]).querySelector('.command-hint__icon'))
    expect(plain.style.width).toBe(iconed.style.width)
    expect(plain.style.width).toBeTruthy()
    expect(plain.style.flexGrow).toBe('0')
    expect(plain.style.flexShrink).toBe('0')
  })

  it('floors the name slot ONLY without subgrid — a shared track hugs the widest name itself', () => {
    const name = /** @type {HTMLElement} */ (row(provider().search('co')[0]).querySelector('.command-hint__name'))
    if (SUBGRID_ROWS) expect(name.style.minWidth).toBe('')
    else expect(name.style.minWidth).toBeTruthy()
    expect(name.style.flexGrow).toBe('0')
  })

  it('lets the description fill the rest, left-aligned — never pushed to the right edge', () => {
    const desc = /** @type {HTMLElement} */ (row(provider().search('co')[0]).querySelector('.command-hint__desc'))
    expect(desc.style.flexGrow).toBe('1')
    expect(desc.style.textAlign).toBe('left')
  })

  // The trait, not the candidates in hand, decides the column: `/` and `@` name
  // their candidates rather than picturing them, so their rows are flush left
  // with no phantom indent. A popover session only ever renders ONE provider's
  // rows, so two shapes can never appear in one list.
  it('drops the slot entirely for a provider that declares no icon column', () => {
    const bare = new (class extends TriggerProvider {
      draw() { return this.renderRow('/note', 'Make a note') }
    })()
    expect(bare.providesIcons).toBe(false)
    const el = document.createElement('div')
    el.appendChild(bare.draw())
    expect(slots(el)).toEqual(['command-hint__name', 'command-hint__desc'])
    expect(el.querySelector('.command-hint__name')?.textContent).toBe('/note')
  })

  it('is the SAME helper the `/` and `@` rows already draw through', () => {
    const el = document.createElement('div')
    el.appendChild(new SlashCommandProvider({ list: () => [] }).render({ name: 'note', description: 'Make a note' }))
    expect(slots(el)).toEqual(['command-hint__name', 'command-hint__desc'])
    expect(el.querySelector('.command-hint__name')?.textContent).toBe('/note')
  })
})

/** @param {HTMLElement} el @returns {string[]} the row's slots, in order */
function slots(el) { return Array.from(el.children).map((c) => c.className) }

/** @param {any} item @returns {HTMLElement} the drawn row, in a detached parent */
function row(item) {
  const el = document.createElement('div')
  el.appendChild(provider().render(item))
  return el
}
