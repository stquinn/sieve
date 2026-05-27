package aiblock

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v2"
)

// AiBlockData holds all fields of a fenced ai-block YAML block.
type AiBlockData struct {
	ID          string `yaml:"id"`
	Ref         string `yaml:"ref,omitempty"`
	Status      string `yaml:"status,omitempty"`
	Type        string `yaml:"type,omitempty"`
	Model       string `yaml:"model,omitempty"`
	CreatedAt   string `yaml:"createdAt,omitempty"`
	CompletedAt string `yaml:"completedAt,omitempty"`
	Question    string `yaml:"question,omitempty"`
	Response    string `yaml:"response,omitempty"`
}

// ParseAll extracts all ai-block fences from a markdown body.
// The line scanner stops at the first ``` line at column 0 after the opening
// ```ai-block — YAML block scalar content is always indented, so inner fences
// never appear at column 0.
func ParseAll(body string) []AiBlockData {
	lines := strings.Split(body, "\n")
	var blocks []AiBlockData
	i := 0
	for i < len(lines) {
		if lines[i] == "```ai-block" {
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var data AiBlockData
				if err := yaml.Unmarshal([]byte(content), &data); err == nil && data.ID != "" {
					blocks = append(blocks, data)
				}
				i = j + 1
				continue
			}
		}
		i++
	}
	return blocks
}

// Replace finds the block with matching ID and rewrites it with updated fields.
func Replace(body string, updated AiBlockData) (string, error) {
	lines := strings.Split(body, "\n")
	startIdx, endIdx := -1, -1

	for i := 0; i < len(lines); i++ {
		if lines[i] != "```ai-block" {
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
		var data AiBlockData
		if yaml.Unmarshal([]byte(content), &data) != nil || data.ID != updated.ID {
			continue
		}
		startIdx, endIdx = i, j
		break
	}

	if startIdx == -1 {
		return body, fmt.Errorf("aiblock: block %q not found", updated.ID)
	}

	serialized := SerializeYAML(updated)
	newFence := []string{"```ai-block"}
	newFence = append(newFence, strings.Split(serialized, "\n")...)
	newFence = append(newFence, "```")

	out := make([]string, 0, len(lines)+len(newFence))
	out = append(out, lines[:startIdx]...)
	out = append(out, newFence...)
	out = append(out, lines[endIdx+1:]...)
	return strings.Join(out, "\n"), nil
}

// yamlScalar quotes a flow scalar if it contains YAML-special characters.
// Mirrors the yamlScalar helper in sieve/webclip/webclip.go and JS extensions.
func yamlScalar(s string) string {
	if s == "" {
		return s
	}
	needsQuote := strings.ContainsAny(s, `:#{}[]|>&*!,`) ||
		strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ")
	if !needsQuote {
		return s
	}
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// SerializeYAML builds the YAML body (without fence markers) for an AiBlockData.
func SerializeYAML(d AiBlockData) string {
	var lines []string
	lines = append(lines, "id: "+d.ID)
	ref := d.Ref
	if ref == "" {
		ref = "doc"
	}
	lines = append(lines, "ref: "+ref)
	status := d.Status
	if status == "" {
		status = "PENDING"
	}
	lines = append(lines, "status: "+status)
	if d.Type != "" {
		lines = append(lines, "type: "+d.Type)
	}
	if d.Model != "" {
		lines = append(lines, "model: "+yamlScalar(d.Model))
	}
	if d.CreatedAt != "" {
		lines = append(lines, "createdAt: "+yamlScalar(d.CreatedAt))
	}
	if d.CompletedAt != "" {
		lines = append(lines, "completedAt: "+yamlScalar(d.CompletedAt))
	}
	if d.Question != "" {
		if strings.Contains(d.Question, "\n") {
			// Block scalar — 4-space indent so inner ``` lines can't close the outer fence
			lines = append(lines, "question: |")
			for _, l := range strings.Split(d.Question, "\n") {
				lines = append(lines, "    "+l)
			}
		} else {
			// Flow scalar — quote if it contains YAML-special characters
			lines = append(lines, "question: "+yamlScalar(d.Question))
		}
	}
	if d.Response != "" {
		lines = append(lines, "response: |")
		for _, l := range strings.Split(d.Response, "\n") {
			if l == "" {
				lines = append(lines, "    ")
			} else {
				lines = append(lines, "    "+l)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// InsertAfterRef inserts pendingFence into body immediately after the block
// identified by the last non-"doc" segment of ref. If no anchor is found
// (or ref is "doc"/empty), the fence is appended to the end of body.
func InsertAfterRef(body, ref, pendingFence string) string {
	// Find the anchor: last non-doc segment of the comma-separated ref.
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
		// Detect opening of a recognised fenced block at column 0.
		if !inBlock && (line == "```ai-block" || line == "```web-clip") {
			inBlock = true
			blockHasAnchor = false
			continue
		}
		if inBlock {
			// Top-level id field (never indented in our YAML schema).
			if strings.HasPrefix(line, "id: ") && strings.TrimPrefix(line, "id: ") == anchorID {
				blockHasAnchor = true
			}
			// Closing fence at column 0 (inner fences are always 4-space indented).
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

	// Anchor not found — append to end.
	return strings.TrimRight(body, "\n") + "\n\n" + pendingFence + "\n"
}
