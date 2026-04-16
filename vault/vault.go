package vault

import (
	"fmt"
	"os"
	"path/filepath"
)

// Vault represents an opened vault on disk.
type Vault struct {
	Root     string // absolute path to the vault root directory
	Hostname string // os.Hostname(), used as the host subdirectory name
	HostDir  string // absolute path to vault/{hostname}/
}

// Open resolves rootPath into a ready-to-use Vault. Missing directories are
// created silently. Orphaned .tmp files from previous crashes are removed.
// Following the spec's defensive handling rules — this never fails on a missing
// directory, only on a fundamentally unusable path.
func Open(rootPath string) (*Vault, error) {
	root, err := filepath.Abs(rootPath)
	if err != nil {
		return nil, fmt.Errorf("vault path: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		// Degrade gracefully — a static fallback is better than a crash
		hostname = "localhost"
	}

	v := &Vault{
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

// IsNewVault returns true when the vault was freshly created (no notes and no
// host settings exist yet). Used to decide whether to show a welcome message.
func (v *Vault) IsNewVault() bool {
	files, _ := os.ReadDir(v.NotesPath())
	return len(files) == 0
}

// ── Path helpers ──────────────────────────────────────────────────────────────

func (v *Vault) NotesPath() string        { return filepath.Join(v.Root, "notes") }
func (v *Vault) AssetsPath() string       { return filepath.Join(v.Root, "assets") }
func (v *Vault) SettingsPath() string     { return filepath.Join(v.HostDir, "settings.json") }
func (v *Vault) SessionPath() string      { return filepath.Join(v.HostDir, "session.json") }
func (v *Vault) BuffersPath() string      { return filepath.Join(v.HostDir, "buffers") }
func (v *Vault) BufferAssetsPath() string { return filepath.Join(v.HostDir, "buffers", "assets") }
func (v *Vault) PromptsPath() string      { return filepath.Join(v.HostDir, "prompts") }

// ── Internal ──────────────────────────────────────────────────────────────────

// ensureDirs creates all required vault subdirectories if they are missing.
func (v *Vault) ensureDirs() error {
	dirs := []string{
		v.NotesPath(),
		v.AssetsPath(),
		v.BuffersPath(),
		v.BufferAssetsPath(),
		v.PromptsPath(),
		v.HostHistoryDir(),
		v.VaultHistoryDir(),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create vault dir %s: %w", dir, err)
		}
	}
	return nil
}

// cleanTmpFiles removes any orphaned .tmp files left by a previous crash.
func (v *Vault) cleanTmpFiles() {
	matches, _ := filepath.Glob(filepath.Join(v.BuffersPath(), "*.tmp"))
	for _, f := range matches {
		os.Remove(f)
	}
}
