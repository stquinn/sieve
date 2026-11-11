// @ts-check
// What a host hands the lens of a Digital Note: the note's one block, read as
// any block is, the pages drawn on it, and the transcripts of those pages. A page
// is asked for whole; every later change to it arrives on the container's feed
// as one stroke added or one removed, each naming the seq of the log record
// that made it. A page's transcript is asked for, and each change to it arrives on
// the feed whole.

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
 * holding it drops every stroke event for the page at or below `seq`. The page
 * comes as `page` or, to an asker that named its renderer, as `drawing`: the SVG
 * document that renderer kept of it, whose root element carries `data-ink-key`,
 * `data-ink-renderer`, `data-ink-strokes` (how many strokes it draws) and
 * `data-ink-newest` (the latest `startMillis` among them, -1 with none). Exactly
 * one of the two is set. `key` names the note's whole log as it stood at `seq`.
 * @typedef {Readonly<{page: Readonly<InkPage>|null, drawing: string|null, seq: number, key: string}>} InkPageAnswer
 */

/** The `type` of each event an ink container's feed delivers. */
export const InkFeed = Object.freeze({
  STROKE_ADDED: 'stroke-added',
  STROKE_REMOVED: 'stroke-removed',
  LIVE: 'live',
  LIVE_PAGE: 'live-page',
  LOG_RESTARTED: 'log-restarted',
  TRANSCRIPT: 'transcript',
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
 * Which page of this note the tablet shows as being written, and the uuid of
 * the Live view mirroring it; `live` false and `pageId` and `view` null when
 * none is any more. Live records arrive only while one is.
 * @typedef {Readonly<{type: 'live-page', live: boolean, pageId: string|null, view: string|null}>} InkLivePage
 */

/**
 * The note's log started again from its first record: every page answer and
 * seq held is void, and a page is asked for again to be drawn as it now stands.
 * @typedef {Readonly<{type: 'log-restarted'}>} InkLogRestarted
 */

/** Whether a page has a transcript, and of what. */
export const InkTranscriptState = Object.freeze({
  /** no transcript is kept */
  NONE: 'none',
  /** a transcript of the page as it is now */
  READY: 'ready',
  /** a transcript of the page as it was before it changed */
  STALE: 'stale',
})

/**
 * What is known of the transcript of one page: its state, the key of the page it
 * is of ('' with none), its blocks in the page's order (empty with none),
 * whether a transcript is under way, whether anything can read a page and, when
 * nothing can, why, and what went wrong the last time the page was read ('' when
 * nothing did).
 * @typedef {Readonly<{pageId: string, state: string, key: string,
 *   blocks: ReadonlyArray<Readonly<import('./container-provider.js').BlockData>>,
 *   running: boolean, available: boolean, unavailable: string, failed: string}>} InkTranscript
 */

/**
 * What is now known of the transcript of a page: a transcript of it began, or ended
 * in a transcript kept or in a failure.
 * @typedef {Readonly<{type: 'transcript', transcript: InkTranscript}>} InkTranscriptChanged
 */

/** @typedef {InkStrokeAdded|InkStrokeRemoved|InkLive|InkLivePage|InkLogRestarted|InkTranscriptChanged} InkFeedEvent */

/** What came of asking the tablet the note came from to open it. */
export const InkOpening = Object.freeze({
  /** the tablet shows the note, live */
  OPENED: 'opened',
  /** no tablet is connected */
  NO_TABLET: 'no-tablet',
  /** a tablet is connected that the note did not come from */
  OTHER_TABLET: 'other-tablet',
  /** the tablet refused, for a reason */
  REFUSED: 'refused',
  /** the tablet did not answer in time */
  NO_ANSWER: 'no-answer',
})

/** The reasons the tablet gives for refusing; it may give another. */
export const InkRefusal = Object.freeze({
  /** SieveInk is not the app in front on the tablet */
  NOT_FOREGROUND: 'not-foreground',
  /** the note is not in a folder the tablet shares with this Sieve */
  NOT_OFFERED: 'not-offered',
})

/**
 * What came of asking the tablet to open the note: one of InkOpening, and the
 * tablet's reason ('' unless refused).
 * @typedef {Readonly<{outcome: string, reason: string}>} InkOpeningResult
 */

/**
 * The read minimum and the feed, plus the pages, plus a query that asks the
 * tablet the note came from to open it at a page — a command to the tablet that
 * names the note and the page alone and changes nothing here — plus the transcripts
 * of the pages.
 *
 * - `loadPage` REJECTS for a page the note does not have, and when the host
 *   cannot answer. Given `renderer`, the version of the asker's ink renderer, it
 *   may answer with the drawing that renderer kept of the page in place of the
 *   page; without one it answers the page.
 * - `keepDrawing` hands over the drawing made of a page from the answer whose
 *   key is `key`, for a later `loadPage` to answer with while the note stands as
 *   it did. Nothing answers it, and a drawing of a note that has moved on is
 *   dropped.
 * - `openOnTablet` asks for the note at the page `pageId` names, the page shown
 *   here; a page the note does not have leaves the page to the tablet. It
 *   REJECTS when nothing could be asked: the container holds no note from a
 *   tablet, or the host did not answer.
 * - `loadTranscript` answers what is known of a page's transcript; `transcribePage` starts
 *   transcript it, unless it has a transcript of what it holds now or is being read,
 *   and answers what is then known, the transcript's end arriving on the feed. Both
 *   REJECT for a page the note does not have, and when the host cannot answer.
 * - `newDocumentFromTranscript` makes an ordinary new document holding a copy of
 *   the page's transcript, linked to nothing, and resolves its uuid; it REJECTS when
 *   the page has no transcript, and when the host cannot answer. Nothing of the
 *   note or its transcript changes.
 * - `refreshDescription` asks for the note to be named now — its name, summary,
 *   keywords and categories described again from its pages, whether or not they
 *   are of the note as it stands — and resolves once the host has accepted the
 *   request (one already under way included). It REJECTS with an Error whose
 *   message is the host's words, fit to show a person, when nothing could be
 *   asked: no AI is configured, the note has no ink, nothing can draw its pages,
 *   or the host did not answer. The new name arrives as the container's name.
 *
 * @typedef {import('./container-provider.js').ContainerProvider & {
 *   loadPage: (pageId: string, renderer?: string) => Promise<InkPageAnswer>,
 *   keepDrawing: (pageId: string, key: string, drawing: string) => void,
 *   openOnTablet: (pageId: string) => Promise<InkOpeningResult>,
 *   loadTranscript: (pageId: string) => Promise<InkTranscript>,
 *   transcribePage: (pageId: string) => Promise<InkTranscript>,
 *   newDocumentFromTranscript: (pageId: string) => Promise<string>,
 *   refreshDescription: () => Promise<void>,
 * }} InkContainerProvider
 */
