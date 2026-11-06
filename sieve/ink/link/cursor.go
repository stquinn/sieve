package link

import (
	"crypto/sha256"
	"fmt"
)

// Cursor is how far a replica holds a note's log: the seq of its last record and the hash chain
// h(n) = SHA-256(h(n-1) ‖ body(n)) at it. The zero Cursor holds nothing, with h(0) all zeros.
type Cursor struct {
	Seq  uint32
	Hash [32]byte
}

// Accept advances the cursor past r, whose canonical body (r.Body()) is body. It refuses, and
// leaves the cursor as it was, a record whose seq is not one greater than the cursor's.
func (c *Cursor) Accept(r Record, body []byte) error {
	if r.Seq != c.Seq+1 {
		return fmt.Errorf("record seq %d after %d", r.Seq, c.Seq)
	}
	h := sha256.New()
	h.Write(c.Hash[:])
	h.Write(body)
	c.Seq = r.Seq
	copy(c.Hash[:], h.Sum(nil))
	return nil
}
