// @ts-check
// ident.js — identity for everything Sieve persists, on the client side (issue
// #96). The JS twin of Go's `ident/` leaf, and deliberately its mirror image:
// same UUIDv7 form, same strict `valid` predicate, same reason for existing —
// two copies of "mint a uuid" is exactly the divergence one package prevents.
//
// A CLIENT MINTS REAL IDS. That is not a shortcut around Go's authority, it is
// what version 7 is for: a UUIDv7 is unique without coordination, so a block can
// be born with its durable identity wherever it is born. A paragraph the user
// typed carries its id from the keystroke that made it; Go's role on that path
// is not to mint but to VALIDATE — well-formed, and not already in the document.
// Every other path (paste, AI, transform) is still born in Go and still minted
// there. One rule, two birthplaces.
//
// This module is a LEAF: it imports nothing, so both sides of the Lens↔Host wall
// can depend on it. It is on the lens-isolation allowlist for that reason.

// The v7 layout (RFC 9562 §5.7), by byte:
//   0..5   unix_ts_ms, big-endian
//   6      version nibble (0111) | rand_a high nibble
//   7      rand_a low byte
//   8      variant bits (10) | rand_b high 6 bits
//   9..15  rand_b
const BYTES = 16
const VERSION_BYTE = 6
const VARIANT_BYTE = 8

/** Hex pairs for 0..255, so formatting never re-pads per byte. */
const HEX = Object.freeze(Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')))

// The canonical 8-4-4-4-12 form, and nothing else. Deliberately STRICTER than a
// permissive parser: the urn:, braced and hyphen-less spellings are forms we
// never mint, so a value in one of them is not one of ours and must answer
// false. Mirrors Go's ident.Valid, including its length check.
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const Ident = Object.freeze({
  /**
   * Mints a UUIDv7 — time-ordered, so ids sort chronologically and a document's
   * blocks carry their birth order in their names.
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
   * Whether `s` is a UUID in the canonical form this mints. The predicate that
   * decides whether an id is one of ours — Go asks the same question of every id
   * a client sends, and answering it differently on the two sides is how a block
   * gets a name only one of them will accept.
   * @param {unknown} s @returns {boolean}
   */
  valid(s) { return typeof s === 'string' && s.length === 36 && CANONICAL.test(s) },
})
