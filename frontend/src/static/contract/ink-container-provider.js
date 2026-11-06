// @ts-check
// What a host hands the lens of a Digital Note: the note's one block, read as
// any block is, and the pages drawn on it. A page is asked for whole; every
// later change to it arrives on the container's feed as one stroke added or one
// removed, each naming the seq of the log record that made it.

/**
 * One sampled pen point, in page units.
 * @typedef {object} InkPagePoint
 * @property {number} x
 * @property {number} y
 * @property {number} pressure   0..1
 * @property {number} tMillis    ms since the stroke's first point
 * @property {number} tiltX      degrees
 * @property {number} tiltY      degrees
 * @property {number} size       always 0
 */

/**
 * One committed stroke, as a page holds it.
 * @typedef {object} InkPageStroke
 * @property {string} id
 * @property {'pen'|'pencil'} tool
 * @property {1|2|3} widthClass
 * @property {number} startMillis   ms since the note's created
 * @property {ReadonlyArray<Readonly<InkPagePoint>>} points
 */

/**
 * A page in the export shape: the note's header, with the template this page is
 * drawn with, and the page's strokes in the order they were added.
 * @typedef {object} InkPage
 * @property {Readonly<{id: string, created: string, title: string, pageAspect: number,
 *   template: Readonly<{id: string, params: Readonly<Record<string, number>>}>|null,
 *   device: Readonly<{id: string, name: string, model: string}>}>} note
 * @property {ReadonlyArray<Readonly<InkPageStroke>>} strokes
 */

/**
 * A page and the seq of the last record of the note's log it reflects. A lens
 * holding it drops every stroke event for the page at or below `seq`.
 * @typedef {Readonly<{page: Readonly<InkPage>, seq: number}>} InkPageAnswer
 */

/** The `type` of each event an ink container's feed delivers. */
export const InkFeed = Object.freeze({
  STROKE_ADDED: 'stroke-added',
  STROKE_REMOVED: 'stroke-removed',
  LIVE: 'live',
  LIVE_PAGE: 'live-page',
  LOG_RESTARTED: 'log-restarted',
})

/**
 * A stroke now present on a page.
 * @typedef {Readonly<{type: 'stroke-added', pageId: string, seq: number, stroke: Readonly<InkPageStroke>}>} InkStrokeAdded
 */

/**
 * A stroke gone from a page.
 * @typedef {Readonly<{type: 'stroke-removed', pageId: string, seq: number, strokeId: string}>} InkStrokeRemoved
 */

/**
 * One record about the stroke under the pen on the live page, or about the
 * window a whiteboard is viewed through, in page units. `record` selects which
 * fields mean anything; the rest are 0:
 *
 *   begin   stroke, tool, widthClass, x and y the stroke's origin
 *   point   stroke, x and y its place, pressure, tMillis since its begin, tiltX, tiltY
 *   end     stroke
 *   remove  stroke — the stroke under the pen is abandoned
 *   view    x and y the top-left of the window on an unbounded page
 *
 * `stroke` numbers a stroke within one connection to the tablet; it is not the
 * stroke's id, and the committed stroke arrives later as a stroke-added. A point
 * whose begin the lens did not hear is drawn from the next begin.
 *
 * @typedef {Readonly<{record: 'begin'|'point'|'end'|'remove'|'view', stroke: number,
 *   tool: 'pen'|'pencil'|null, widthClass: number, x: number, y: number,
 *   pressure: number, tMillis: number, tiltX: number, tiltY: number}>} InkLiveRecord
 */

/**
 * Live records, in the order the tablet sent them.
 * @typedef {Readonly<{type: 'live', records: ReadonlyArray<InkLiveRecord>}>} InkLive
 */

/**
 * Which page of this note the tablet shows as being written; `live` false and
 * `pageId` null when none is any more. Live records arrive only while one is.
 * @typedef {Readonly<{type: 'live-page', live: boolean, pageId: string|null}>} InkLivePage
 */

/**
 * The note's log started again from its first record: every page answer and
 * seq held is void, and a page is asked for again to be drawn as it now stands.
 * @typedef {Readonly<{type: 'log-restarted'}>} InkLogRestarted
 */

/** @typedef {InkStrokeAdded|InkStrokeRemoved|InkLive|InkLivePage|InkLogRestarted} InkFeedEvent */

/**
 * The read minimum and the feed, plus the pages. `loadPage` REJECTS for a page
 * the note does not have, and when the host cannot answer.
 *
 * @typedef {import('./container-provider.js').ContainerProvider & {
 *   loadPage: (pageId: string) => Promise<InkPageAnswer>,
 * }} InkContainerProvider
 */
