package webclip

import "sieve/sieve/fencedblock"

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
	return fencedblock.ParseAll[WebClipData](body, "web-clip")
}

// Replace finds the block with matching ID and rewrites it with updated fields.
func Replace(body string, updated WebClipData) (string, error) {
	return fencedblock.Replace(body, "web-clip", updated.ID, updated)
}

// SerializeYAML builds the YAML body (without fence markers) for a WebClipData.
// Applies "PENDING" default for empty Status before encoding.
func SerializeYAML(d WebClipData) string {
	if d.Status == "" {
		d.Status = "PENDING"
	}
	s, _ := fencedblock.Serialize(d)
	return s
}
