// @ts-check
// Identity for everything Sieve persists, client-side. The JS twin of Go's `ident/`
// leaf: same UUIDv7 form, same strict `valid` predicate.
//
// A CLIENT MINTS REAL IDS. A UUIDv7 is unique without coordination, so a block is
// born with its durable identity wherever it is born, and on the lens path Go's
// role is to VALIDATE rather than mint. Every other path is still minted in Go.

// The v7 layout (RFC 9562 §5.7), which the byte indices below address:
//   0..5 unix_ts_ms big-endian · 6 version | rand_a · 8 variant | rand_b · 9..15 rand_b
const BYTES = 16
const VERSION_BYTE = 6
const VARIANT_BYTE = 8

/** Hex pairs for 0..255, so formatting never re-pads per byte. */
const HEX = Object.freeze(Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')))

// Deliberately STRICTER than a permissive parser: the urn:, braced and hyphen-less
// spellings are forms we never mint, so a value in one of them is not one of ours.
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const Ident = Object.freeze({
  /**
   * Mints a UUIDv7. Time-ordered ACROSS milliseconds only: rand_a is random here,
   * where Go's uuid.NewV7 puts a sequence counter in it, so ids minted in the same
   * millisecond are unordered relative to each other and to Go's. Nothing sorts by
   * id — container order is an explicit list — so do not start.
   * @returns {string} the canonical 8-4-4-4-12 form
   */
  mint() {
    const bytes = new Uint8Array(BYTES)
    crypto.getRandomValues(bytes)

    // 48-bit big-endian millisecond timestamp. Written with arithmetic rather
    // than bit shifts on purpose: JS bitwise operators truncate to 32 bits, and
    // the high two bytes of a millisecond clock are past that.
    let ms = Date.now()
    for (let i = 5; i >= 0; i--) {
      bytes[i] = ms % 256
      ms = Math.floor(ms / 256)
    }
    bytes[VERSION_BYTE] = (bytes[VERSION_BYTE] & 0x0f) | 0x70  // version 7
    bytes[VARIANT_BYTE] = (bytes[VARIANT_BYTE] & 0x3f) | 0x80  // variant RFC 4122

    let out = ''
    for (let i = 0; i < BYTES; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) out += '-'
      out += HEX[bytes[i]]
    }
    return out
  },

  /**
   * Whether `s` is a UUID in the canonical form this mints. Go asks the same
   * question of every id a client sends, and the two answers must agree.
   * @param {unknown} s @returns {boolean}
   */
  valid(s) { return typeof s === 'string' && s.length === 36 && CANONICAL.test(s) },
})
