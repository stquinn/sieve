package stash

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// NewBufferResult is returned by NewBuffer so the caller has both the
// store-relative path and the permanent UUID in one call.
type NewBufferResult struct {
	Path string `json:"path"`
	UUID string `json:"uuid"`
}

// NewBuffer creates a new empty buffer file in {hostname}/buffers/ with an
// initial meta block including a freshly generated UUID.
// Returns the store-relative path and the UUID.
func (v *Store) NewBuffer() (NewBufferResult, error) {
	now := time.Now()
	filename := fmt.Sprintf("buf-%s.md", now.Format("20060102-1504"))

	absPath := filepath.Join(v.BuffersPath(), filename)

	// Collision guard — two new buffers in the same minute
	if _, err := os.Stat(absPath); err == nil {
		filename = fmt.Sprintf("buf-%s-%d.md", now.Format("20060102-1504"), now.UnixNano()%10000)
		absPath = filepath.Join(v.BuffersPath(), filename)
	}

	uuid := newUUID()
	n := v.nextUntitledNumber()
	if err := os.WriteFile(absPath, []byte(newBufferMeta(now, n, uuid)), 0o644); err != nil {
		return NewBufferResult{}, fmt.Errorf("create buffer: %w", err)
	}

	rel, err := filepath.Rel(v.Root, absPath)
	if err != nil {
		return NewBufferResult{}, err
	}
	return NewBufferResult{Path: rel, UUID: uuid}, nil
}

// newUUID generates a random UUID (v4).
func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// nextUntitledNumber scans existing buffers for "display_name: Untitled N"
// entries and returns max(N)+1, so each new buffer gets a unique label.
func (v *Store) nextUntitledNumber() int {
	files, err := os.ReadDir(v.BuffersPath())
	if err != nil {
		return 1
	}
	rx := regexp.MustCompile(`display_name:\s*Untitled\s+(\d+)`)
	max := 0
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(v.BuffersPath(), f.Name()))
		if err != nil {
			continue
		}
		if m := rx.FindSubmatch(data); m != nil {
			if n, err := strconv.Atoi(string(m[1])); err == nil && n > max {
				max = n
			}
		}
	}
	return max + 1
}

// DiscardBuffer removes a buffer file from disk and deletes unfiled assets and version history.
func (v *Store) DiscardBuffer(absPath string) error {
	data, err := os.ReadFile(absPath)
	if err == nil {
		content := string(data)
		// Match both forms of buffer asset reference:
		//   assets/blk-xxx.png          — relative to {hostname}/buffers/ dir
		//   (../)*buffers/assets/blk-xxx.png — older style
		rx := regexp.MustCompile(`(?:(?:\.\./)*buffers/)?assets/(blk-[a-zA-Z0-9-]+\.[a-zA-Z0-9]+)`)
		matches := rx.FindAllStringSubmatch(content, -1)
		for _, m := range matches {
			if len(m) >= 2 {
				candidate := filepath.Join(v.BufferAssetsPath(), m[1])
				// Only delete if the file actually lives in buffers/assets/ (not store/assets/)
				if _, err := os.Stat(candidate); err == nil {
					os.Remove(candidate)
				}
			}
		}
		// Delete version history keyed by UUID
		if m := regexp.MustCompile(`(?m)^uuid:\s*(\S+)`).FindSubmatch(data); m != nil {
			v.DeleteHistory(strings.TrimSpace(string(m[1])))
		}
	}
	return os.Remove(absPath)
}

// FileBufferResult is returned by FileBuffer so the frontend can sync the updated content.
type FileBufferResult struct {
	NewPath string `json:"newPath"`
	Content string `json:"content"`
}

// FileBuffer moves a buffer to store/ using a kebab-case filename derived
// from user_suggested_name, the first heading, or a timestamp fallback.
// The frontmatter status field is updated to "filed" before writing.
// Returns the result containing new path and updated content.
func (v *Store) FileBuffer(absPath string) (FileBufferResult, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return FileBufferResult{}, fmt.Errorf("file buffer: read: %w", err)
	}
	content := replaceFmField(string(data), "status", "filed")
	name := deriveKebabName(content)
	
	folder := deriveFolderPath(content)
	destDir := v.NotesPath()
	if folder != "" {
		destDir = filepath.Join(v.NotesPath(), folder)
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			return FileBufferResult{}, fmt.Errorf("file buffer: mkdir: %w", err)
		}
	}

	dest := uniqueNotesPath(destDir, name)

	// Avoid deleting if same path
	if absPath == dest {
		if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
			return FileBufferResult{}, fmt.Errorf("file buffer: write in-place: %w", err)
		}
		rel, err := filepath.Rel(v.Root, dest)
		if err != nil {
			return FileBufferResult{NewPath: dest, Content: content}, nil
		}
		return FileBufferResult{NewPath: rel, Content: content}, nil
	}

	// Asset promotion: scan for images linking to buffer assets.
	// Matches both:
	//   assets/blk-xxx.png            — relative from buffer dir
	//   (../)*buffers/assets/blk-xxx.png — older style
	rx := regexp.MustCompile(`(?:(?:\.\./)*buffers/)?assets/(blk-[a-zA-Z0-9-]+\.[a-zA-Z0-9]+)`)
	var copiedFiles []string

	// Compute the relative prefix from the note to store/.assets/.
	// A note at store/ needs ".assets/", at store/sub/ needs "../.assets/", etc.
	depth := 0
	if folder != "" {
		depth = len(strings.Split(filepath.ToSlash(folder), "/"))
	}
	assetPrefix := strings.Repeat("../", depth) + ".assets/"

	content = rx.ReplaceAllStringFunc(content, func(match string) string {
		filename := rx.FindStringSubmatch(match)[1]
		srcPath := filepath.Join(v.BufferAssetsPath(), filename)

		fmt.Printf("[stash:store] FileBuffer promotion check: match=%s, src=%s\n", match, srcPath)

		// Only promote assets that still exist in buffers/assets/
		if _, err := os.Stat(srcPath); err != nil {
			fmt.Printf("[stash:store] FileBuffer promotion: src not found locally\n")
			return match // not found — leave unchanged
		}

		destFilename := name + "-" + filename
		destPath := filepath.Join(v.AssetsPath(), destFilename)
		fmt.Printf("[stash:store] FileBuffer promotion: moving to %s\n", destPath)

		// Collision check
		if _, err := os.Stat(destPath); err == nil {
			destFilename = fmt.Sprintf("%s-%d-%s", name, time.Now().UnixNano()%10000, filename)
			destPath = filepath.Join(v.AssetsPath(), destFilename)
		}

		srcData, err := os.ReadFile(srcPath)
		if err == nil {
			if err := os.WriteFile(destPath, srcData, 0o644); err == nil {
				copiedFiles = append(copiedFiles, srcPath)
			} else {
				fmt.Printf("[stash:store] FileBuffer promotion: write fail: %v\n", err)
			}
		} else {
			fmt.Printf("[stash:store] FileBuffer promotion: read fail: %v\n", err)
		}

		return assetPrefix + destFilename
	})

	if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
		return FileBufferResult{}, fmt.Errorf("file buffer: write: %w", err)
	}
	if err := os.Remove(absPath); err != nil {
		return FileBufferResult{}, fmt.Errorf("file buffer: remove source: %w", err)
	}

	// Clean up old assets
	for _, f := range copiedFiles {
		os.Remove(f)
	}

	// History promotion
	if uuidMatch := regexp.MustCompile(`(?m)^uuid:\s*(\S+)`).FindSubmatch([]byte(content)); uuidMatch != nil {
		uuidStr := strings.TrimSpace(string(uuidMatch[1]))
		if err := os.MkdirAll(v.StoreHistoryDir(), 0o755); err == nil {
			matches, _ := filepath.Glob(filepath.Join(v.HostHistoryDir(), uuidStr+".*.md"))
			for _, m := range matches {
				os.Rename(m, filepath.Join(v.StoreHistoryDir(), filepath.Base(m)))
			}
		}
	}

	rel, err := filepath.Rel(v.Root, dest)
	if err != nil {
		return FileBufferResult{NewPath: dest, Content: content}, nil
	}
	return FileBufferResult{NewPath: rel, Content: content}, nil
}

// FileBufferWithName is like FileBuffer but first writes name into the
// user_suggested_name frontmatter field so deriveKebabName will pick it up.
func (v *Store) FileBufferWithName(absPath, name string) (FileBufferResult, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return FileBufferResult{}, fmt.Errorf("file buffer with name: read: %w", err)
	}
	updated := replaceFmField(string(data), "user_suggested_name", name)
	if err := os.WriteFile(absPath, []byte(updated), 0o644); err != nil {
		return FileBufferResult{}, fmt.Errorf("file buffer with name: write fm: %w", err)
	}
	return v.FileBuffer(absPath)
}

// deriveKebabName extracts a meaningful kebab-case name from buffer content.
// Priority: filename frontmatter field → user_suggested_name frontmatter field → first heading → timestamp.
func deriveKebabName(content string) string {
	var filename, userSuggested string
	for _, line := range strings.SplitN(content, "\n", 200) {
		if strings.HasPrefix(line, "filename:") {
			filename = strings.TrimSpace(strings.TrimPrefix(line, "filename:"))
			filename = strings.Trim(filename, `"'`)
			filename = strings.TrimSuffix(filename, ".md")
		} else if strings.HasPrefix(line, "user_suggested_name:") {
			userSuggested = strings.TrimSpace(strings.TrimPrefix(line, "user_suggested_name:"))
			userSuggested = strings.Trim(userSuggested, `"'`)
		}
	}
	
	if filename != "" && filename != "null" {
		return toKebab(filename)
	}
	if userSuggested != "" && userSuggested != "null" {
		return toKebab(userSuggested)
	}

	inFm := strings.HasPrefix(content, "---")
	pastFm := !inFm
	for _, line := range strings.SplitN(content, "\n", 200) {
		if !pastFm {
			if strings.TrimSpace(line) == "---" {
				// first --- opens, second --- closes
				if inFm && strings.Count(content[:strings.Index(content, line)+3], "---") >= 2 {
					pastFm = true
				}
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			heading := strings.TrimLeft(line, "#")
			heading = strings.TrimSpace(heading)
			if heading != "" {
				return toKebab(heading)
			}
		}
	}
	return "note-" + time.Now().Format("20060102-1504")
}

func toKebab(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash && b.Len() > 0 {
			b.WriteByte('-')
			prevDash = true
		}
	}
	result := strings.TrimRight(b.String(), "-")
	if result == "" {
		return "untitled"
	}
	if len(result) > 60 {
		result = result[:60]
	}
	return result
}

func uniqueNotesPath(notesDir, name string) string {
	base := filepath.Join(notesDir, name+".md")
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return base
	}
	for i := 2; ; i++ {
		p := filepath.Join(notesDir, fmt.Sprintf("%s-%d.md", name, i))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
}

// replaceFmField replaces the value of a YAML frontmatter field in-place.
func replaceFmField(content, key, value string) string {
	prefix := key + ":"
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, prefix) {
			lines[i] = key + ": " + value
			break
		}
	}
	return strings.Join(lines, "\n")
}

func newBufferMeta(t time.Time, untitledN int, uuid string) string {
	ts := t.Format("2006-01-02T15:04:05")
	return fmt.Sprintf(`---
uuid: %s
status: unfiled
version: 0
focus_count: 0
user_intent: null
ai_eval: none
ai_last_evaluated: null
ai_folder_suggestion: null
user_suggested_name: null
display_name: Untitled %d
filename: null
summary: null
tags: []
ai_justification: null
density_signals: []
created: %s
modified: %s
cli: null
---
`, uuid, untitledN, ts, ts)
}

func deriveFolderPath(content string) string {
	for _, line := range strings.SplitN(content, "\n", 200) {
		if strings.HasPrefix(line, "ai_folder_suggestion:") {
			folder := strings.TrimSpace(strings.TrimPrefix(line, "ai_folder_suggestion:"))
			folder = strings.Trim(folder, `"'`)
			if folder != "null" && folder != "" {
				return cleanFolderPath(folder)
			}
		} else if strings.HasPrefix(line, "folder:") {
			folder := strings.TrimSpace(strings.TrimPrefix(line, "folder:"))
			folder = strings.Trim(folder, `"'`)
			if folder != "null" && folder != "" {
				return cleanFolderPath(folder)
			}
		}
	}
	return ""
}

func cleanFolderPath(folder string) string {
	segments := strings.Split(filepath.ToSlash(folder), "/")
	var valid []string
	for _, seg := range segments {
		clean := cleanFolderSegment(seg)
		if clean != "" {
			valid = append(valid, clean)
		}
	}
	if len(valid) > 0 {
		return filepath.Join(valid...)
	}
	return ""
}

func cleanFolderSegment(s string) string {
	s = strings.TrimSpace(s)
	
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
			prevSpace = false
		} else if r == ' ' {
			if !prevSpace {
				b.WriteRune(r)
				prevSpace = true
			}
		}
	}
	
	result := strings.TrimSpace(b.String())
	if result == "." || result == ".." {
		return ""
	}
	return result
}
