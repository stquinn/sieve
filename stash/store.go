package stash

import (
	"fmt"
	"os"
	"path/filepath"
)

// Store represents an opened store on disk.
type Store struct {
	Root     string // absolute path to the store root directory
	Hostname string // os.Hostname(), used as the host subdirectory name
	HostDir  string // absolute path to store/{hostname}/
}

// Open resolves rootPath into a ready-to-use Store. Missing directories are
// created silently. Orphaned .tmp files from previous crashes are removed.
// Following the spec's defensive handling rules — this never fails on a missing
// directory, only on a fundamentally unusable path.
func Open(rootPath string) (*Store, error) {
	root, err := filepath.Abs(rootPath)
	if err != nil {
		return nil, fmt.Errorf("store path: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		// Degrade gracefully — a static fallback is better than a crash
		hostname = "localhost"
	}

	v := &Store{
		Root:     root,
		Hostname: hostname,
		HostDir:  filepath.Join(root, hostname),
	}

	if err := v.ensureDirs(); err != nil {
		return nil, err
	}

	v.cleanTmpFiles()

	return v, nil
}

// IsNewStore returns true when the store was freshly created (no notes and no
// host settings exist yet). Used to decide whether to show a welcome message.
func (v *Store) IsNewStore() bool {
	return CountNotes(v.NotesPath()) == 0
}

// ── Path helpers ──────────────────────────────────────────────────────────────

func (v *Store) StorePath() string        { return filepath.Join(v.Root, "store") }
func (v *Store) NotesPath() string        { return v.StorePath() }
func (v *Store) AssetsPath() string       { return filepath.Join(v.StorePath(), ".assets") }
func (v *Store) SettingsPath() string     { return filepath.Join(v.HostDir, "settings.json") }
func (v *Store) SessionPath() string      { return filepath.Join(v.HostDir, "session.json") }
func (v *Store) BuffersPath() string      { return filepath.Join(v.HostDir, "buffers") }
func (v *Store) BufferAssetsPath() string { return filepath.Join(v.HostDir, "buffers", "assets") }
func (v *Store) PromptsPath() string      { return filepath.Join(v.HostDir, "prompts") }

// ── Internal ──────────────────────────────────────────────────────────────────

// ensureDirs creates all required store subdirectories if they are missing.
func (v *Store) ensureDirs() error {
	dirs := []string{
		v.StorePath(),
		v.AssetsPath(),
		v.BuffersPath(),
		v.BufferAssetsPath(),
		v.PromptsPath(),
		v.HostHistoryDir(),
		v.StoreHistoryDir(),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create store dir %s: %w", dir, err)
		}
	}
	return nil
}

// cleanTmpFiles removes any orphaned .tmp files left by a previous crash.
func (v *Store) cleanTmpFiles() {
	matches, _ := filepath.Glob(filepath.Join(v.BuffersPath(), "*.tmp"))
	for _, f := range matches {
		os.Remove(f)
	}
}
