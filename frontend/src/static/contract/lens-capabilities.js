// @ts-check
// The capability vocabulary of the Lens↔Host wall: the words a lens publishes
// about itself, and the word an offerable entry names as its requirement.
//
// ONE CONSTANT SERVES BOTH SIDES, so matching an entry to a mount is a plain key
// lookup — `caps[entry.requires]` — with no mapping table between two spellings
// and no bare string literal on either side.

export const LensCapability = Object.freeze({
  /** inserts markdown-representable flow into the prose */
  MARKDOWN: 'markdown',
  /** offers the `@` typeahead */
  MENTIONS: 'mentions',
  /** offers `/` slash-command dispatch */
  COMMANDS: 'commands',
  /** mints Sieve blocks in its container */
  BLOCKS: 'blocks',
})

/** Every capability word, for a consumer validating a declaration against the
 *  vocabulary rather than trusting a string.
 *  @type {ReadonlyArray<string>} */
export const LENS_CAPABILITIES = Object.freeze(Object.values(LensCapability))

/**
 * A lens's published specification: what it can do, computed once from its
 * innate abilities and the dependencies it was actually given, and frozen for
 * the lens's life.
 *
 * A `false` is a fact about this lens, not a reason: a capability its class
 * forbids and one it was simply never given a service for read the same, and a
 * consumer never learns which.
 *
 * @typedef {object} LensCapabilities
 * @property {boolean} markdown
 * @property {boolean} mentions
 * @property {boolean} commands
 * @property {boolean} blocks
 */
