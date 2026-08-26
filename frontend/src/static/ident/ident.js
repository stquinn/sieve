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

// Monotonic counter state for rand_a (mirrors google/uuid's getV7Time), so a
// mint always emits a (ms, seq) pair strictly greater than every previous one.
let lastMs = 0
let lastSeq = 0

export const Ident = Object.freeze({
  /**
   * Mints a UUIDv7. Time-ordered, and strictly monotonic even for ids minted
   * within the same millisecond: rand_a carries a 12-bit sequence counter, not
   * random bits, matching Go's uuid.NewV7. A later mint always sorts after an
   * earlier one, lexicographically, by construction.
   * @returns {string} the canonical 8-4-4-4-12 form
   */
  mint() {
    const bytes = new Uint8Array(BYTES)
    crypto.getRandomValues(bytes)

    const now = Date.now()
    if (now > lastMs) {
      lastMs = now
      lastSeq = 0
    } else {
      lastSeq++
      if (lastSeq > 0xfff) {
        lastMs++
        lastSeq = 0
      }
    }

    // 48-bit big-endian millisecond timestamp. Written with arithmetic rather
    // than bit shifts on purpose: JS bitwise operators truncate to 32 bits, and
    // the high two bytes of a millisecond clock are past that.
    let ms = lastMs
    for (let i = 5; i >= 0; i--) {
      bytes[i] = ms % 256
      ms = Math.floor(ms / 256)
    }
    bytes[VERSION_BYTE] = 0x70 | (lastSeq >> 8)  // version 7 | seq high nibble
    bytes[VARIANT_BYTE] = (bytes[VARIANT_BYTE] & 0x3f) | 0x80  // variant RFC 4122
    bytes[7] = lastSeq & 0xff  // seq low byte

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
