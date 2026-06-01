package fencedblock

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// ParseAll scans body for ```tag…``` fences and unmarshals each into T.
// Blocks that fail to unmarshal or have an empty "id" field are skipped.
func ParseAll[T any](body, tag string) []T {
	fence := "```" + tag
	lines := strings.Split(body, "\n")
	var out []T
	i := 0
	for i < len(lines) {
		if lines[i] == fence {
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var meta struct {
					ID string `yaml:"id"`
				}
				if yaml.Unmarshal([]byte(content), &meta) == nil && meta.ID != "" {
					var v T
					if yaml.Unmarshal([]byte(content), &v) == nil {
						out = append(out, v)
					}
				}
				i = j + 1
				continue
			}
		}
		i++
	}
	return out
}

// Serialize encodes v as YAML with 4-space indentation using yaml.v3.
// The library handles quoting of special characters automatically.
// 4-space indent ensures block scalar content can never trigger a closing
// fence (CommonMark allows fences with 0–3 leading spaces only).
func Serialize[T any](v T) (string, error) {
	var buf strings.Builder
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(4)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// Replace finds the fence block in body with `id: blockID` and replaces its
// YAML content with a freshly serialized updated value.
func Replace[T any](body, tag, blockID string, updated T) (string, error) {
	fence := "```" + tag
	lines := strings.Split(body, "\n")
	startIdx, endIdx := -1, -1

	for i := 0; i < len(lines); i++ {
		if lines[i] != fence {
			continue
		}
		j := i + 1
		for j < len(lines) && lines[j] != "```" {
			j++
		}
		if j >= len(lines) {
			break
		}
		content := strings.Join(lines[i+1:j], "\n")
		var meta struct {
			ID string `yaml:"id"`
		}
		if yaml.Unmarshal([]byte(content), &meta) != nil || meta.ID != blockID {
			continue
		}
		startIdx, endIdx = i, j
		break
	}

	if startIdx == -1 {
		return body, fmt.Errorf("fencedblock: %s block %q not found", tag, blockID)
	}

	serialized, err := Serialize(updated)
	if err != nil {
		return body, fmt.Errorf("fencedblock: serialize failed: %w", err)
	}

	newFence := []string{fence}
	newFence = append(newFence, strings.Split(serialized, "\n")...)
	newFence = append(newFence, "```")

	out := make([]string, 0, len(lines)+len(newFence))
	out = append(out, lines[:startIdx]...)
	out = append(out, newFence...)
	out = append(out, lines[endIdx+1:]...)
	return strings.Join(out, "\n"), nil
}

// InsertAfterRef inserts pendingFence into body immediately after the block
// identified by the last non-"doc" segment of ref. Falls back to appending
// at end of body if the anchor is not found or ref is "doc"/empty.
//
// All named fenced blocks (```tag) are scanned for the anchor id. Closing
// fences are detected by an exact ```` ``` ```` line at column 0; inner fences
// inside block scalars are always 4-space indented and never match.
func InsertAfterRef(body, ref, pendingFence string) string {
	anchorID := ""
	for _, part := range strings.Split(ref, ",") {
		id := strings.TrimSpace(part)
		if id != "" && id != "doc" {
			anchorID = id
		}
	}

	if anchorID == "" {
		return strings.TrimRight(body, "\n") + "\n\n" + pendingFence + "\n"
	}

	lines := strings.Split(body, "\n")
	inBlock := false
	blockHasAnchor := false

	for i, line := range lines {
		if !inBlock && strings.HasPrefix(line, "```") && len(line) > 3 {
			inBlock = true
			blockHasAnchor = false
			continue
		}
		if inBlock {
			if strings.HasPrefix(line, "id: ") && strings.TrimPrefix(line, "id: ") == anchorID {
				blockHasAnchor = true
			}
			if line == "```" {
				if blockHasAnchor {
					out := make([]string, 0, len(lines)+4)
					out = append(out, lines[:i+1]...)
					out = append(out, "")
					out = append(out, strings.Split(pendingFence, "\n")...)
					out = append(out, lines[i+1:]...)
					return strings.Join(out, "\n")
				}
				inBlock = false
			}
		}
	}

	return strings.TrimRight(body, "\n") + "\n\n" + pendingFence + "\n"
}
