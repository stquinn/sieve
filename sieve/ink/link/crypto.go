// Package link is the protocol a Sieve speaks to a SieveInk companion over one connection: the
// pairing key and its proofs, the sealed frame stream, the frames, the log records with their
// binary and JSON Lines codecs and their hash chain, the live point feed, and the session that
// replicates a companion's notes into replicas it does not know how to store. It works over any
// io.ReadWriter and knows nothing of Bluetooth. docs/ink-contract.md is its normative definition.
package link

import (
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/chacha20poly1305"
)

// Direction is the first word of a sealed frame's nonce: which way the frame travels.
type Direction uint32

const (
	CompanionToSieve Direction = 0
	SieveToCompanion Direction = 1
)

const sessionInfo = "sieve-ink session v1"

// Key is the 80-bit pre-shared key of one pairing. It never travels.
type Key [10]byte

// NewKey mints a fresh random key.
func NewKey() (Key, error) {
	var k Key
	_, err := rand.Read(k[:])
	return k, err
}

// ParseKey reads the 16 RFC 4648 base32 characters a Sieve shows; whitespace, hyphens and case
// are ignored.
func ParseKey(text string) (Key, error) {
	var k Key
	clean := strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "\n", "", "\r", "", "\t", "").Replace(text))
	if len(clean) != 16 {
		return k, fmt.Errorf("a pairing key is 16 characters, not %d", len(clean))
	}
	if _, err := base32.StdEncoding.Decode(k[:], []byte(clean)); err != nil {
		return k, fmt.Errorf("a pairing key uses A to Z and 2 to 7: %w", err)
	}
	return k, nil
}

// Text is the key as a Sieve shows it: four groups of four base32 characters. It is the secret.
func (k Key) Text() string {
	s := base32.StdEncoding.EncodeToString(k[:])
	return s[:4] + " " + s[4:8] + " " + s[8:12] + " " + s[12:]
}

func (k Key) mac(parts ...[]byte) []byte {
	m := hmac.New(sha256.New, k[:])
	for _, p := range parts {
		m.Write(p)
	}
	return m.Sum(nil)
}

// SieveID is the name HELLO gives: lowercase hex of the first 8 bytes of HMAC-SHA256(key, "sieve-id").
func (k Key) SieveID() string { return hex.EncodeToString(k.mac([]byte("sieve-id"))[:8]) }

// SieveProof is HMAC-SHA256(key, cNonce ‖ "sieve").
func (k Key) SieveProof(cNonce []byte) []byte { return k.mac(cNonce, []byte("sieve")) }

// CompanionProof is HMAC-SHA256(key, sNonce ‖ "companion").
func (k Key) CompanionProof(sNonce []byte) []byte { return k.mac(sNonce, []byte("companion")) }

// SessionKey is HKDF-SHA256(salt = cNonce ‖ sNonce, ikm = key, info = "sieve-ink session v1", L = 32).
func (k Key) SessionKey(cNonce, sNonce []byte) ([]byte, error) {
	salt := append(append([]byte{}, cNonce...), sNonce...)
	return hkdf.Key(sha256.New, k[:], salt, sessionInfo, 32)
}

// sealer is one connection's ChaCha20-Poly1305 with no additional data.
type sealer struct{ aead cipher.AEAD }

func newSealer(sessionKey []byte) (*sealer, error) {
	aead, err := chacha20poly1305.New(sessionKey)
	if err != nil {
		return nil, err
	}
	return &sealer{aead}, nil
}

// nonce is the direction u32 then the counter u64, little-endian.
func (d Direction) nonce(counter uint64) []byte {
	n := make([]byte, chacha20poly1305.NonceSize)
	binary.LittleEndian.PutUint32(n, uint32(d))
	binary.LittleEndian.PutUint64(n[4:], counter)
	return n
}

func (s *sealer) seal(d Direction, counter uint64, plain []byte) []byte {
	return s.aead.Seal(nil, d.nonce(counter), plain, nil)
}

func (s *sealer) open(d Direction, counter uint64, sealed []byte) ([]byte, error) {
	plain, err := s.aead.Open(nil, d.nonce(counter), sealed, nil)
	if err != nil {
		return nil, fmt.Errorf("a sealed frame did not open: %w", err)
	}
	return plain, nil
}
