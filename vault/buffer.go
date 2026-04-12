package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// NewBuffer creates a new empty buffer file in {hostname}/buffers/ with an
// initial meta block. Returns the path relative to the vault root.
func (v *Vault) NewBuffer() (string, error) {
	now := time.Now()
	filename := fmt.Sprintf("buf-%s.md", now.Format("20060102-1504"))

	absPath := filepath.Join(v.BuffersPath(), filename)

	// Collision guard — two new buffers in the same minute
	if _, err := os.Stat(absPath); err == nil {
		filename = fmt.Sprintf("buf-%s-%d.md", now.Format("20060102-1504"), now.UnixNano()%10000)
		absPath = filepath.Join(v.BuffersPath(), filename)
	}

	if err := os.WriteFile(absPath, []byte(newBufferMeta(now)), 0o644); err != nil {
		return "", fmt.Errorf("create buffer: %w", err)
	}

	rel, err := filepath.Rel(v.Root, absPath)
	if err != nil {
		return "", err
	}
	return rel, nil
}

// DiscardBuffer removes a buffer file from disk and deletes unfiled assets.
func (v *Vault) DiscardBuffer(absPath string) error {
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
				// Only delete if the file actually lives in buffers/assets/ (not vault/assets/)
				if _, err := os.Stat(candidate); err == nil {
					os.Remove(candidate)
				}
			}
		}
	}
	return os.Remove(absPath)
}

// FileBuffer moves a buffer to vault/notes/ using a kebab-case filename derived
// from user_suggested_name, the first heading, or a timestamp fallback.
// The frontmatter status field is updated to "filed" before writing.
// Returns the new path relative to the vault root.
func (v *Vault) FileBuffer(absPath string) (string, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", fmt.Errorf("file buffer: read: %w", err)
	}
	content := replaceFmField(string(data), "status", "filed")
	name := deriveKebabName(content)
	
	folder := deriveFolderPath(content)
	destDir := v.NotesPath()
	if folder != "" {
		destDir = filepath.Join(v.NotesPath(), folder)
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			return "", fmt.Errorf("file buffer: mkdir: %w", err)
		}
	}

	dest := uniqueNotesPath(destDir, name)

	// Avoid deleting if same path
	if absPath == dest {
		if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
			return "", fmt.Errorf("file buffer: write in-place: %w", err)
		}
		rel, err := filepath.Rel(v.Root, dest)
		if err != nil {
			return dest, nil
		}
		return rel, nil
	}

	// Asset promotion: scan for images linking to buffer assets.
	// Matches both:
	//   assets/blk-xxx.png            — relative from buffer dir
	//   (../)*buffers/assets/blk-xxx.png — older style
	rx := regexp.MustCompile(`(?:(?:\.\./)*buffers/)?assets/(blk-[a-zA-Z0-9-]+\.[a-zA-Z0-9]+)`)
	var copiedFiles []string

	content = rx.ReplaceAllStringFunc(content, func(match string) string {
		filename := rx.FindStringSubmatch(match)[1]
		srcPath := filepath.Join(v.BufferAssetsPath(), filename)

		// Only promote assets that still exist in buffers/assets/
		if _, err := os.Stat(srcPath); err != nil {
			return match // not found — leave unchanged
		}

		destFilename := name + "-" + filename
		destPath := filepath.Join(v.AssetsPath(), destFilename)

		// Collision check
		if _, err := os.Stat(destPath); err == nil {
			destFilename = fmt.Sprintf("%s-%d-%s", name, time.Now().UnixNano()%10000, filename)
			destPath = filepath.Join(v.AssetsPath(), destFilename)
		}

		srcData, err := os.ReadFile(srcPath)
		if err == nil {
			if err := os.WriteFile(destPath, srcData, 0o644); err == nil {
				copiedFiles = append(copiedFiles, srcPath)
			}
		}

		return "../assets/" + destFilename
	})

	if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("file buffer: write: %w", err)
	}
	if err := os.Remove(absPath); err != nil {
		return "", fmt.Errorf("file buffer: remove source: %w", err)
	}

	// Clean up old assets
	for _, f := range copiedFiles {
		os.Remove(f)
	}

	rel, err := filepath.Rel(v.Root, dest)
	if err != nil {
		return dest, nil
	}
	return rel, nil
}

// FileBufferWithName is like FileBuffer but first writes name into the
// user_suggested_name frontmatter field so deriveKebabName will pick it up.
func (v *Vault) FileBufferWithName(absPath, name string) (string, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", fmt.Errorf("file buffer with name: read: %w", err)
	}
	updated := replaceFmField(string(data), "user_suggested_name", name)
	if err := os.WriteFile(absPath, []byte(updated), 0o644); err != nil {
		return "", fmt.Errorf("file buffer with name: write fm: %w", err)
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

func newBufferMeta(t time.Time) string {
	ts := t.Format("2006-01-02T15:04:05")
	return fmt.Sprintf(`---
status: unfiled
version: 0
focus_count: 0
user_intent: null
ai_eval: none
ai_last_evaluated: null
ai_folder_suggestion: null
user_suggested_name: null
filename: null
summary: null
tags: []
created: %s
modified: %s
cli: null
---
`, ts, ts)
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
		k := toKebab(seg)
		if k != "untitled" && k != "" {
			valid = append(valid, k)
		}
	}
	if len(valid) > 0 {
		return filepath.Join(valid...)
	}
	return ""
}
