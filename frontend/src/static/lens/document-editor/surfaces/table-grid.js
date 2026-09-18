// @ts-check
// The rectangle a table node lays out on, as document positions.
//
// A row or a column is a RECTANGLE of the table, not a list of a row node's
// children: a cell carrying a `rowspan` occupies slots in rows whose child list
// does not hold it, and a `colspan` puts one cell in several columns. Reading a
// range off child indices is therefore wrong for any table with a merge in it,
// which is why the range a selection needs is answered here.
//
// This holds no ProseMirror. It reads `attrs.colspan`, `attrs.rowspan` and
// `nodeSize` off the node it is handed, so it is testable without an editor.

/** A pair of cell positions naming a rectangle, in `setCellSelection`'s words.
 *  @typedef {{anchorCell: number, headCell: number}} CellRange */

export class TableGrid {
  /** @type {number} */ #width
  /** @type {number} */ #height
  /** Row-major, `#width * #height` entries: the document position of the cell
   *  covering each slot, or -1 where a malformed table leaves one uncovered.
   *  @type {number[]} */ #slots

  /** @param {any} table a `table` node
   *  @param {number} tablePos the document position BEFORE `table` */
  constructor(table, tablePos) {
    /** @type {any[]} */ const rows = []
    table.forEach((/** @type {any} */ row) => rows.push(row))

    // The width is the widest row's spans. In a well-formed table that is the
    // full width, because a row losing cells to a rowspan above it is narrower
    // by exactly what it lost; in a malformed one it can under-count, and the
    // cells past it are left unplaced — a range over them answers null rather
    // than a wrong rectangle.
    let width = 0
    rows.forEach((row) => {
      let spanned = 0
      row.forEach((/** @type {any} */ c) => { spanned += TableGrid.#span(c, 'colspan') })
      if (spanned > width) width = spanned
    })

    this.#width = width
    this.#height = rows.length
    this.#slots = new Array(width * rows.length).fill(-1)

    let rowPos = tablePos + 1
    rows.forEach((row, r) => {
      let cellPos = rowPos + 1
      let col = 0
      row.forEach((/** @type {any} */ c) => {
        while (col < width && this.#slots[r * width + col] >= 0) col++
        const colspan = TableGrid.#span(c, 'colspan')
        const rowspan = TableGrid.#span(c, 'rowspan')
        for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++) {
          for (let dc = 0; dc < colspan && col + dc < width; dc++) {
            this.#slots[(r + dr) * width + col + dc] = cellPos
          }
        }
        col += colspan
        cellPos += c.nodeSize
      })
      rowPos += row.nodeSize
    })
  }

  /** @returns {number} how many columns the table has */
  get width() { return this.#width }

  /** @returns {number} how many rows the table has */
  get height() { return this.#height }

  /** The whole row the cell at `cellPos` sits in, or null when no cell of this
   *  table starts there. A cell spanning several rows is read at the first of
   *  them, which is the row a selection through it reaches for.
   *  @param {number} cellPos @returns {CellRange|null} */
  rowRangeAt(cellPos) {
    const slot = this.#slotOf(cellPos)
    if (!slot) return null
    return this.#rangeOver((i) => this.#slots[slot.row * this.#width + i], this.#width)
  }

  /** The whole column the cell at `cellPos` sits in, or null when no cell of
   *  this table starts there.
   *  @param {number} cellPos @returns {CellRange|null} */
  columnRangeAt(cellPos) {
    const slot = this.#slotOf(cellPos)
    if (!slot) return null
    return this.#rangeOver((i) => this.#slots[i * this.#width + slot.col], this.#height)
  }

  /** The first slot `cellPos` covers, or null. A negative position is rejected
   *  before the lookup: -1 is the hole sentinel, so it would otherwise MATCH.
   *  @param {number} cellPos @returns {{row: number, col: number}|null} */
  #slotOf(cellPos) {
    if (cellPos < 0) return null
    const at = this.#slots.indexOf(cellPos)
    if (at < 0) return null
    return { row: Math.floor(at / this.#width), col: at % this.#width }
  }

  /** The first and last covered position of one line of `count` slots. A
   *  malformed table can leave a hole at either end, so the ends are the
   *  outermost COVERED slots rather than slot 0 and slot count-1.
   *  @param {(i: number) => number} slotAt @param {number} count
   *  @returns {CellRange|null} */
  #rangeOver(slotAt, count) {
    let anchorCell = -1
    let headCell = -1
    for (let i = 0; i < count; i++) {
      const pos = slotAt(i)
      if (pos < 0) continue
      if (anchorCell < 0) anchorCell = pos
      headCell = pos
    }
    return anchorCell < 0 ? null : { anchorCell, headCell }
  }

  /** A span attribute, defaulting to 1 for a node that declares none.
   *  @param {any} cell @param {string} name @returns {number} */
  static #span(cell, name) {
    const raw = cell.attrs ? cell.attrs[name] : 1
    return (typeof raw === 'number' && raw > 0) ? raw : 1
  }
}
