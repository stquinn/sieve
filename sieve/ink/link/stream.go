package link

import (
	"encoding/binary"
	"fmt"
	"io"
	"sync"

	"golang.org/x/crypto/chacha20poly1305"
)

// The longest frame, before sealing, that each side accepts.
const (
	limitBeforeProof   = 256
	limitFromSieve     = 64 * 1024
	limitFromCompanion = 16*1024*1024 + 1024
)

// frameStream is frames on a link's byte stream: u32 little-endian length, then that many bytes,
// in the clear until upgrade and sealed after it, each direction counting its frames from 0. Any
// error is final: the caller must drop the link. One goroutine reads; any may write.
type frameStream struct {
	r       io.Reader
	w       io.Writer
	writeMu sync.Mutex

	seal        *sealer
	sending     Direction
	receiving   Direction
	sendCount   uint64
	receiveSeen uint64
}

func newFrameStream(link io.ReadWriter) *frameStream { return &frameStream{r: link, w: link} }

func (s *frameStream) upgrade(sessionKey []byte, sending, receiving Direction) error {
	sl, err := newSealer(sessionKey)
	if err != nil {
		return err
	}
	s.seal, s.sending, s.receiving = sl, sending, receiving
	return nil
}

// write sends one frame with one write to the stream.
func (s *frameStream) write(frame []byte) error {
	return s.writeIf(func() bool { return true }, frame)
}

// writeIf sends frame as write does when ok, asked under the write lock, says it may be sent; so
// what ok records is in the order frames are written. ok must not write.
func (s *frameStream) writeIf(ok func() bool, frame []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !ok() {
		return nil
	}
	payload := frame
	if s.seal != nil {
		payload = s.seal.seal(s.sending, s.sendCount, frame)
		s.sendCount++
	}
	wire := binary.LittleEndian.AppendUint32(make([]byte, 0, 4+len(payload)), uint32(len(payload)))
	_, err := s.w.Write(append(wire, payload...))
	return err
}

// read returns the next frame, refusing one longer than limit before sealing.
func (s *frameStream) read(limit int) ([]byte, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(s.r, prefix[:]); err != nil {
		return nil, err
	}
	length := binary.LittleEndian.Uint32(prefix[:])
	sealedLimit := limit
	if s.seal != nil {
		sealedLimit += chacha20poly1305.Overhead
	}
	if length > uint32(sealedLimit) {
		return nil, fmt.Errorf("a frame of %d bytes is over the limit of %d", length, limit)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(s.r, payload); err != nil {
		return nil, err
	}
	if s.seal == nil {
		return payload, nil
	}
	plain, err := s.seal.open(s.receiving, s.receiveSeen, payload)
	s.receiveSeen++
	return plain, err
}
