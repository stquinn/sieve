// @ts-check
// table-selection.test.js — what a table selection is made of: the rectangle
// TableGrid answers, and the skin that makes prosemirror-tables' selection
// visible (#147).
//
// A ROW OR COLUMN IS A RECTANGLE, NOT A LIST OF CHILDREN. The menu's Select Row
// and Select Column hand prosemirror-tables two cell POSITIONS, and the second
// one is only findable through the grid: a cell carrying a rowspan occupies
// slots in rows whose child list does not contain it, so walking a row's
// children answers the wrong question the moment a table has a merge in it.
//
// The grid holds no ProseMirror: it reads `attrs.colspan`/`attrs.rowspan` and
// `nodeSize` off whatever node it is given, so these cases build real PM nodes
// only because a real node is the cheapest honest fixture.

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { TableGrid } from '../src/static/lens/document-editor/surfaces/table-grid.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: {},
    table: { group: 'block', content: 'tableRow+', toDOM: () => ['table', ['tbody', 0]] },
    tableRow: { content: '(tableCell | tableHeader)+', toDOM: () => ['tr', 0] },
    tableCell: {
      content: 'paragraph+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
      toDOM: () => ['td', 0],
    },
    tableHeader: {
      content: 'paragraph+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
      toDOM: () => ['th', 0],
    },
  },
})
const n = schema.nodes

/** One cell holding `text`, spanning `colspan` × `rowspan`. */
function cell(text, attrs) {
  return n.tableCell.create(attrs || null, n.paragraph.create(null, schema.text(text)))
}

/** A doc holding ONE table built from `rows` (arrays of cells), with the table
 *  as its first child — so the table's position is 0 and every cell position the
 *  grid reports is a real position in this doc.
 *  @returns {{doc: any, table: any, tablePos: number}} */
function docWithTable(rows) {
  const table = n.table.create(null, rows.map((cells) => n.tableRow.create(null, cells)))
  return { doc: n.doc.create(null, [table]), table, tablePos: 0 }
}

/** The doc position of the cell at child index `col` of row `row`. */
function cellPos(table, tablePos, row, col) {
  let pos = tablePos + 1
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize
  let cur = pos + 1
  for (let c = 0; c < col; c++) cur += table.child(row).child(c).nodeSize
  return cur
}

describe('TableGrid', () => {
  it('measures a plain table', () => {
    const { table, tablePos } = docWithTable([
      [cell('a'), cell('b'), cell('c')],
      [cell('d'), cell('e'), cell('f')],
    ])
    const grid = new TableGrid(table, tablePos)
    expect(grid.width).toBe(3)
    expect(grid.height).toBe(2)
  })

  it('spans a row from its first cell to its last', () => {
    const { table, tablePos } = docWithTable([
      [cell('a'), cell('b'), cell('c')],
      [cell('d'), cell('e'), cell('f')],
    ])
    const grid = new TableGrid(table, tablePos)
    expect(grid.rowRangeAt(cellPos(table, tablePos, 1, 1))).toEqual({
      anchorCell: cellPos(table, tablePos, 1, 0),
      headCell: cellPos(table, tablePos, 1, 2),
    })
  })

  it('spans a column from its top cell to its bottom', () => {
    const { table, tablePos } = docWithTable([
      [cell('a'), cell('b'), cell('c')],
      [cell('d'), cell('e'), cell('f')],
    ])
    const grid = new TableGrid(table, tablePos)
    expect(grid.columnRangeAt(cellPos(table, tablePos, 1, 1))).toEqual({
      anchorCell: cellPos(table, tablePos, 0, 1),
      headCell: cellPos(table, tablePos, 1, 1),
    })
  })

  it('reports a one-cell table as its own row and its own column', () => {
    const { table, tablePos } = docWithTable([[cell('a')]])
    const grid = new TableGrid(table, tablePos)
    const only = cellPos(table, tablePos, 0, 0)
    expect(grid.rowRangeAt(only)).toEqual({ anchorCell: only, headCell: only })
    expect(grid.columnRangeAt(only)).toEqual({ anchorCell: only, headCell: only })
  })

  it('answers nothing for a position that is not a cell of this table', () => {
    const { table, tablePos } = docWithTable([[cell('a'), cell('b')]])
    const grid = new TableGrid(table, tablePos)
    expect(grid.rowRangeAt(0)).toBeNull()
    expect(grid.columnRangeAt(9999)).toBeNull()
  })

  // A colspan makes one cell occupy two slots of its row: the column through
  // either of them ends at that cell, and the row's last slot is the merged
  // cell itself rather than a third child that does not exist.
  it('resolves a column through a horizontally merged cell', () => {
    const { table, tablePos } = docWithTable([
      [cell('wide', { colspan: 2, rowspan: 1 })],
      [cell('c'), cell('d')],
    ])
    const grid = new TableGrid(table, tablePos)
    expect(grid.width).toBe(2)
    const wide = cellPos(table, tablePos, 0, 0)
    expect(grid.columnRangeAt(cellPos(table, tablePos, 1, 1))).toEqual({
      anchorCell: wide,
      headCell: cellPos(table, tablePos, 1, 1),
    })
    expect(grid.rowRangeAt(wide)).toEqual({ anchorCell: wide, headCell: wide })
  })

  // A rowspan puts a cell in a row whose child list does not hold it. The
  // second row's own child is the RIGHT-hand column, so a naive first-child
  // read would span that row from the wrong place.
  it('resolves a row through a vertically merged cell', () => {
    const { table, tablePos } = docWithTable([
      [cell('tall', { colspan: 1, rowspan: 2 }), cell('b')],
      [cell('d')],
    ])
    const grid = new TableGrid(table, tablePos)
    expect(grid.width).toBe(2)
    expect(grid.height).toBe(2)
    const tall = cellPos(table, tablePos, 0, 0)
    const d = cellPos(table, tablePos, 1, 0)
    expect(grid.rowRangeAt(d)).toEqual({ anchorCell: tall, headCell: d })
    expect(grid.columnRangeAt(d)).toEqual({
      anchorCell: cellPos(table, tablePos, 0, 1),
      headCell: d,
    })
  })

  it('finds the merged cell from every slot it occupies', () => {
    const { table, tablePos } = docWithTable([
      [cell('tall', { colspan: 1, rowspan: 2 }), cell('b')],
      [cell('d')],
    ])
    const grid = new TableGrid(table, tablePos)
    const tall = cellPos(table, tablePos, 0, 0)
    expect(grid.columnRangeAt(tall)).toEqual({ anchorCell: tall, headCell: tall })
  })
})

// THE DEFECT #147 REPORTS IS AN ABSENT RULE. prosemirror-tables has always set
// `selectedCell` on every cell of a CellSelection; the app's stylesheet simply
// had nothing to say about the class, so a working selection was invisible.
// Nothing in JS can catch that, which is why the stylesheet is read here.
describe('the cell-selection skin', () => {
  const css = fs.readFileSync(
    path.resolve(process.cwd(), 'src/static/editor.css'), 'utf8')

  it('paints the class prosemirror-tables marks a selected cell with', () => {
    expect(css).toMatch(/\.selectedCell/)
  })

  // A `background` loses: the header row and the even rows already paint one,
  // so the same selection would read differently over each.
  it('paints it as an overlay over the header and zebra backgrounds', () => {
    expect(css).toMatch(/\.selectedCell::after\s*\{[^}]*position:\s*absolute/)
    expect(css).toMatch(/table td\.selectedCell::after\s*\{[^}]*background:\s*var\(--theme-selectionBg\)/)
    expect(css).toMatch(/table td\s*\{\s*position:\s*relative/)
  })

  it('suppresses the browser highlight ProseMirror hides under a cell selection', () => {
    expect(css).toMatch(/\.ProseMirror-hideselection \*::selection\s*\{[^}]*background:\s*transparent/)
  })
})
