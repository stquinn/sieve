package ink

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/ink/link"
)

// NoteStaging holds the records of catch-ups not yet published, outside the library: one file
// per digital-note container, {uuid}.jsonl in its directory, holding §4.1 lines that follow the
// container's published log. Nothing removes a file but Drop and Resume; one left by a container
// since deleted stays until the directory's owner removes it. It is safe for concurrent use on
// different containers.
type NoteStaging struct {
	dir string
}

// StagedLog is what a staged file holds that follows a published log: its bytes, the records
// they are, in seq order, and the cursor they reach. The zero StagedLog is nothing staged.
type StagedLog struct {
	Bytes   []byte
	Records []link.Record
	Cursor  link.Cursor
}

// NewNoteStaging stages in dir, which is created on the first Append.
func NewNoteStaging(dir string) *NoteStaging { return &NoteStaging{dir: dir} }

// Append adds data, whole §4.1 lines, to the end of the staged file of container uuid.
func (s *NoteStaging) Append(uuid string, data []byte) error {
	path, err := s.path(uuid)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("ink: staging a note: %w", err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("ink: staging a note: %w", err)
	}
	_, err = f.Write(data)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("ink: staging a note: %w", err)
	}
	return nil
}

// Resume is the staged log of container uuid as the records that follow the published log from
// stands at. A staged file that is not wholly such records — its first record not the one after
// from, a line that does not parse or does not follow on, a last line with no "\n" — is deleted,
// and Resume is the zero StagedLog; so is a container with nothing staged. An error is a file
// that could not be read or deleted.
func (s *NoteStaging) Resume(uuid string, from link.Cursor) (StagedLog, error) {
	path, err := s.path(uuid)
	if err != nil {
		return StagedLog{}, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return StagedLog{}, nil
	}
	if err != nil {
		return StagedLog{}, fmt.Errorf("ink: reading a staged note: %w", err)
	}
	staged, ok := s.replay(raw, from)
	if ok {
		return staged, nil
	}
	logger.Warn("ink: dropping a staged catch-up that does not follow the published log", "container", uuid, "seq", from.Seq, "bytes", len(raw))
	return StagedLog{}, s.Drop(uuid)
}

// Drop deletes the staged file of container uuid; nothing staged is no error.
func (s *NoteStaging) Drop(uuid string) error {
	path, err := s.path(uuid)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("ink: dropping a staged note: %w", err)
	}
	return nil
}

// replay reads raw as the records that follow from, and reports whether all of it is.
func (s *NoteStaging) replay(raw []byte, from link.Cursor) (StagedLog, bool) {
	staged := StagedLog{Bytes: raw, Cursor: from}
	for rest := raw; len(rest) > 0; {
		end := bytes.IndexByte(rest, '\n')
		if end < 0 {
			return StagedLog{}, false
		}
		rec, err := link.ParseJSONLine(rest[:end+1])
		if err != nil {
			return StagedLog{}, false
		}
		body, err := rec.Body()
		if err != nil {
			return StagedLog{}, false
		}
		if err := staged.Cursor.Accept(rec, body); err != nil {
			return StagedLog{}, false
		}
		staged.Records = append(staged.Records, rec)
		rest = rest[end+1:]
	}
	return staged, true
}

// path is the staged file of container uuid; a uuid that is not one is refused.
func (s *NoteStaging) path(uuid string) (string, error) {
	if !ident.Valid(uuid) {
		return "", fmt.Errorf("ink: %q is not a container uuid", uuid)
	}
	return filepath.Join(s.dir, uuid+".jsonl"), nil
}
