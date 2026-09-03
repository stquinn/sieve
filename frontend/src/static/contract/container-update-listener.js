// @ts-check
// The wall's ONE inbound channel.

/**
 * What changed in one fold step, as JSON-shaped data.
 *
 * `replaced` is a subset of `blockIds`: the blocks the container REPLACED
 * WHOLE, rather than merged onto what it already held. The host executed the
 * change to those blocks itself — a transform, a text rewrite it was asked to
 * make — so the node now in the container is the whole truth for them, and a
 * lens that keeps its own working copy of a block's content must take the
 * host's. Every other cue leaves a lens's own copy alone.
 *
 * It says WHAT happened to the container, never WHO asked: the same list
 * arrives whether this lens's verb, another lens, or a background job caused
 * the replacement.
 *
 * @typedef {object} ContainerChange
 * @property {ReadonlyArray<string>} blockIds   ids whose node arrived, changed or left
 * @property {boolean} orderChanged
 * @property {ReadonlyArray<string>} replaced   ids whose node the container replaced whole
 */

/**
 * One stretch of a block's text the host has something to say about — today a
 * misspelling, tomorrow whatever else reads the same substrate.
 *
 * IT IS ANCHORED BY NAME, NOT BY POSITION. `quote`, `occurrence` and `grain` say
 * which characters are meant; `start`/`end` are offsets into the block's STORED
 * form, which is not the reading a lens draws, so they are a hint and never the
 * answer. A lens finds occurrence `occurrence` of `quote`, counted at `grain`,
 * in its own reading and DROPS the mark where that does not resolve — a mark is
 * derived from text that has since moved on, and staleness is its absence.
 *
 * @typedef {object} SieveTextMark
 * @property {string} locator      which part of the block's payload the mark came from; opaque — only the block's own processor reads it
 * @property {string} quote        the exact text flagged; the anchor, not a label
 * @property {number} occurrence   0-based index among identical quotes in the same part
 * @property {string} grain        how the occurrence is counted — `word` among identical word runs, `literal` among non-overlapping literal matches; declared at the mint, never inferred
 * @property {number} start        offset hint into the block's stored form
 * @property {number} end          offset hint, exclusive
 * @property {string} class        the kind of language the text is — prose, code, label, caption, key
 * @property {ReadonlyArray<string>} suggestions   replacements offered for the quote, best first; never absent, often empty
 */

/**
 * What a lens implements to consume container state. Emitted POST-FOLD, so the
 * handler always reads consistent model state.
 *
 * ORIGIN-BLIND: a lens's own echo, another lens's edit, an AI job and the file
 * watcher arrive here identically, with no thread back to "did I cause this". A
 * lens is told that A change happened; it re-reads and paints.
 *
 * There is no `onAck`. A verb Go declines changes nothing, so nothing fires;
 * failures surface as host errors or as block-attr status changes.
 *
 * `onMarksChanged` is the one cue that CARRIES its answer, because marks are not
 * container state a lens can read back: they are the host's derived reading of a
 * block, held only for as long as something is watching. Each call is one
 * FEATURE's COMPLETE set for one block and replaces what the lens held for that
 * pair, so an empty array is the clear and not a no-op, and one producer's marks
 * never disturb another's. `feature` says WHO found them — a lens draws each
 * producer's findings its own way, and a lens that draws only one ignores the
 * rest. It is optional — a lens with nowhere to draw a mark simply does not
 * implement it — and `subscribe` cues it for every (feature, block) the host
 * already holds marks for, the way it cues `onChanged` with the whole container.
 *
 * @typedef {object} ContainerUpdateListener
 * @property {(change: Readonly<ContainerChange>) => void} onChanged
 * @property {((feature: string, blockId: string, marks: ReadonlyArray<Readonly<SieveTextMark>>) => void)} [onMarksChanged]
 */

export {}
