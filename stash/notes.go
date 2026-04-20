package stash

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func ExtractDisplayName(path string) string {
	return ExtractFromFm(path, `(?m)^display_name:\s*(.+)`)
}

func ExtractUuid(path string) string {
	return ExtractFromFm(path, `(?m)^uuid:\s*(.+)`)
}

func ExtractUserIntent(path string) string {
	return ExtractFromFm(path, `(?m)^user_intent:\s*(.+)`)
}

func ExtractFromFm(path string, pattern string) string {
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
	re := regexp.MustCompile(pattern)
	if m := re.FindStringSubmatch(content); len(m) > 1 {
		val := strings.TrimSpace(m[1])
		val = strings.Trim(val, `"'`)
		if val == "null" || val == "" {
			return ""
		}
		return val
	}
	return ""
}

// NoteEntry represents a single node in the store/ tree.
// Directories have IsDir=true and a Children slice; files have a store-relative Path.
type NoteEntry struct {
	Name        string      `json:"name"`
	DisplayName string      `json:"displayName,omitempty"` // from frontmatter
	Path        string      `json:"path,omitempty"`        // store-relative, empty for directories
	UserIntent  string      `json:"userIntent,omitempty"`  // from frontmatter: "keep", "trash", or ""
	IsDir       bool        `json:"isDir"`
	Children    []NoteEntry `json:"children,omitempty"`
}

// ScanNotes walks notesRoot and returns an alphabetically-ordered tree of
// NoteEntry values. Only .md files are included. Non-.md files and hidden
// entries (dot-prefixed) are skipped. storeRoot is used to compute store-
// relative paths.
func ScanNotes(storeRoot, libraryRoot string) []NoteEntry {
	entries, err := readDir(storeRoot, libraryRoot, libraryRoot)
	if err != nil {
		return nil
	}
	return entries
}

func readDir(storeRoot, dir, libraryRoot string) ([]NoteEntry, error) {
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
			// Special case: skip the .assets folder if at the library root.
			// Users shouldn't see it in the sidebar.
			if info.Name() == ".assets" && dir == libraryRoot {
				continue
			}
			// Skip all other hidden items
			continue
		}

		fullPath := filepath.Join(dir, info.Name())

		if info.IsDir() {
			children, _ := readDir(storeRoot, fullPath, libraryRoot)
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

		rel, err := filepath.Rel(storeRoot, fullPath)
		if err != nil {
			rel = fullPath
		}
		// Always use forward slashes for cross-platform consistency
		name := strings.TrimSuffix(info.Name(), filepath.Ext(info.Name()))
		entries = append(entries, NoteEntry{
			Name:        name,
			DisplayName: ExtractDisplayName(fullPath),
			Path:        filepath.ToSlash(rel),
			UserIntent:  ExtractUserIntent(fullPath),
			IsDir:       false,
		})
	}

	return entries, nil
}

// CountNotes returns the total number of .md files under root, walking
// recursively. Used to skip the sidebar on an empty stash.
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
