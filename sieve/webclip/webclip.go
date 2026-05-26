package webclip

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v2"
)

// WebClipData holds all fields of a fenced web-clip YAML block.
type WebClipData struct {
	ID          string `yaml:"id"`
	Source      string `yaml:"source,omitempty"`
	Title       string `yaml:"title,omitempty"`
	Mode        string `yaml:"mode,omitempty"`
	Status      string `yaml:"status,omitempty"`
	Model       string `yaml:"model,omitempty"`
	CreatedAt   string `yaml:"createdAt,omitempty"`
	CompletedAt string `yaml:"completedAt,omitempty"`
	Content     string `yaml:"content,omitempty"`
	Error       string `yaml:"error,omitempty"`
}

// ParseAll extracts all web-clip fences from a markdown body.
func ParseAll(body string) []WebClipData {
	lines := strings.Split(body, "\n")
	var blocks []WebClipData
	i := 0
	for i < len(lines) {
		if lines[i] == "```web-clip" {
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var data WebClipData
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
func Replace(body string, updated WebClipData) (string, error) {
	lines := strings.Split(body, "\n")
	startIdx, endIdx := -1, -1

	for i := 0; i < len(lines); i++ {
		if lines[i] != "```web-clip" {
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
		var data WebClipData
		if yaml.Unmarshal([]byte(content), &data) != nil || data.ID != updated.ID {
			continue
		}
		startIdx, endIdx = i, j
		break
	}

	if startIdx == -1 {
		return body, fmt.Errorf("webclip: block %q not found", updated.ID)
	}

	serialized := SerializeYAML(updated)
	newFence := []string{"```web-clip"}
	newFence = append(newFence, strings.Split(serialized, "\n")...)
	newFence = append(newFence, "```")

	out := make([]string, 0, len(lines)+len(newFence))
	out = append(out, lines[:startIdx]...)
	out = append(out, newFence...)
	out = append(out, lines[endIdx+1:]...)
	return strings.Join(out, "\n"), nil
}

// yamlScalar returns a safe YAML scalar for a single-line value.
// Values that need quoting (contain YAML special chars or leading/trailing space)
// are returned as double-quoted strings.
func yamlScalar(s string) string {
	needsQuote := strings.ContainsAny(s, `:#{}[]|>&*!,`) ||
		strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ")
	if !needsQuote {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// SerializeYAML builds the YAML body (without fence markers) for a WebClipData.
// Mirrors the serializer in web-clip-extension.js.
func SerializeYAML(d WebClipData) string {
	var lines []string
	lines = append(lines, "id: "+yamlScalar(d.ID))
	lines = append(lines, "source: "+yamlScalar(d.Source))
	if d.Title != "" {
		lines = append(lines, "title: "+yamlScalar(d.Title))
	}
	lines = append(lines, "mode: "+yamlScalar(d.Mode))
	status := d.Status
	if status == "" {
		status = "PENDING"
	}
	lines = append(lines, "status: "+yamlScalar(status))
	if d.Model != "" {
		lines = append(lines, "model: "+yamlScalar(d.Model))
	}
	if d.CreatedAt != "" {
		lines = append(lines, "createdAt: "+yamlScalar(d.CreatedAt))
	}
	if d.CompletedAt != "" {
		lines = append(lines, "completedAt: "+yamlScalar(d.CompletedAt))
	}
	if d.Content != "" {
		lines = append(lines, "content: |")
		for _, l := range strings.Split(d.Content, "\n") {
			lines = append(lines, "  "+l)
		}
	}
	if d.Error != "" {
		lines = append(lines, "error: |")
		for _, l := range strings.Split(d.Error, "\n") {
			lines = append(lines, "  "+l)
		}
	}
	return strings.Join(lines, "\n")
}
