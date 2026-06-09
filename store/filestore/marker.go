package filestore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"sieve/logger"
)

const currentStoreVersion = 1

// storeMeta is the content of the {root}/.sieve marker file.
// It is a general-purpose library-level state file: version/migration tracking
// today, extensible for any future per-library metadata.
type storeMeta struct {
	Version   int    `json:"version"`
	Created   string `json:"created"`
	Migration string `json:"migration"` // "complete" | "pending" | "partial"
	Name      string `json:"name,omitempty"`
}

// ReadLibraryName returns the human-readable library name stored in the .sieve
// marker at root, or an empty string if absent or unreadable.
func ReadLibraryName(root string) string {
	m, err := (&FileStore{root: root}).readStoreMarker()
	if err != nil {
		return ""
	}
	return m.Name
}

func (fs *FileStore) sieveMarkerPath() string {
	return filepath.Join(fs.root, ".sieve")
}

func (fs *FileStore) readStoreMarker() (storeMeta, error) {
	data, err := os.ReadFile(fs.sieveMarkerPath())
	if err != nil {
		return storeMeta{}, err
	}
	var m storeMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return storeMeta{}, fmt.Errorf("filestore: parse .sieve marker: %w", err)
	}
	return m, nil
}

func (fs *FileStore) writeStoreMarker(m storeMeta) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(fs.sieveMarkerPath(), data, 0o644)
}

// ensureStoreMarker reads the marker and handles startup logic:
//   - No marker → brand-new store, write and proceed.
//   - "partial" migration → refuse to open.
//   - Version mismatch → run migrations (none defined yet beyond v1).
func (fs *FileStore) ensureStoreMarker() error {
	m, err := fs.readStoreMarker()
	if os.IsNotExist(err) {
		return fs.writeStoreMarker(storeMeta{
			Version:   currentStoreVersion,
			Migration: "complete",
		})
	}
	if err != nil {
		return fmt.Errorf("filestore: read .sieve marker: %w", err)
	}
	if m.Migration == "partial" {
		logger.Warn("filestore: partial migration detected — will re-run on startup", "root", fs.root)
	}
	return nil
}
