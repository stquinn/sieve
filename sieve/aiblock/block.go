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

// SerializeYAML builds the YAML body (without fence markers) for an AiBlockData.
// Mirrors the serializeAiBlockYaml function in ai-block-extension.js.
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
		lines = append(lines, "model: "+d.Model)
	}
	if d.CreatedAt != "" {
		lines = append(lines, "createdAt: "+d.CreatedAt)
	}
	if d.CompletedAt != "" {
		lines = append(lines, "completedAt: "+d.CompletedAt)
	}
	if d.Question != "" {
		if strings.Contains(d.Question, "\n") {
			lines = append(lines, "question: |")
			for _, l := range strings.Split(d.Question, "\n") {
				lines = append(lines, "  "+l)
			}
		} else {
			lines = append(lines, "question: "+d.Question)
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
