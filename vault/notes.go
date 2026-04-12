package vault

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var displayNameRegex = regexp.MustCompile(`(?m)^display_name:\s*(.+)`)

func extractDisplayName(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	// Read first 2KB — frontmatter is usually at the start
	buf := make([]byte, 2048)
	n, _ := f.Read(buf)
	if n == 0 {
		return ""
	}

	content := string(buf[:n])
	if m := displayNameRegex.FindStringSubmatch(content); len(m) > 1 {
		val := strings.TrimSpace(m[1])
		val = strings.Trim(val, `"'`)
		if val == "null" || val == "" {
			return ""
		}
		return val
	}
	return ""
}

// NoteEntry represents a single node in the vault/notes/ tree.
// Directories have IsDir=true and a Children slice; files have a vault-relative Path.
type NoteEntry struct {
	Name        string      `json:"name"`
	DisplayName string      `json:"displayName,omitempty"` // from frontmatter
	Path        string      `json:"path,omitempty"`        // vault-relative, empty for directories
	IsDir       bool        `json:"isDir"`
	Children    []NoteEntry `json:"children,omitempty"`
}

// ScanNotes walks notesRoot and returns an alphabetically-ordered tree of
// NoteEntry values. Only .md files are included. Non-.md files and hidden
// entries (dot-prefixed) are skipped. vaultRoot is used to compute vault-
// relative paths.
func ScanNotes(vaultRoot, notesRoot string) []NoteEntry {
	entries, err := readDir(vaultRoot, notesRoot)
	if err != nil {
		return nil
	}
	return entries
}

func readDir(vaultRoot, dir string) ([]NoteEntry, error) {
	infos, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var entries []NoteEntry
	for _, info := range infos {
		if strings.HasPrefix(info.Name(), ".") {
			continue // skip hidden
		}

		fullPath := filepath.Join(dir, info.Name())

		if info.IsDir() {
			children, _ := readDir(vaultRoot, fullPath)
			// Include the directory even if empty — user may add files later
			entries = append(entries, NoteEntry{
				Name:     info.Name(),
				IsDir:    true,
				Children: children,
			})
			continue
		}

		if !strings.EqualFold(filepath.Ext(info.Name()), ".md") {
			continue // notes only
		}

		rel, err := filepath.Rel(vaultRoot, fullPath)
		if err != nil {
			rel = fullPath
		}
		// Always use forward slashes for cross-platform consistency
		name := strings.TrimSuffix(info.Name(), filepath.Ext(info.Name()))
		entries = append(entries, NoteEntry{
			Name:        name,
			DisplayName: extractDisplayName(fullPath),
			Path:        filepath.ToSlash(rel),
			IsDir:       false,
		})
	}

	return entries, nil
}

// CountNotes returns the total number of .md files under root, walking
// recursively. Used to skip the sidebar on an empty vault.
func CountNotes(root string) int {
	count := 0
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.EqualFold(filepath.Ext(d.Name()), ".md") {
			count++
		}
		return nil
	})
	return count
}
