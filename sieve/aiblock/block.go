package aiblock

import "sieve/sieve/fencedblock"

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
func ParseAll(body string) []AiBlockData {
	return fencedblock.ParseAll[AiBlockData](body, "ai-block")
}

// Replace finds the block with matching ID and rewrites it with updated fields.
func Replace(body string, updated AiBlockData) (string, error) {
	return fencedblock.Replace(body, "ai-block", updated.ID, updated)
}

// SerializeYAML builds the YAML body (without fence markers) for an AiBlockData.
// Applies "doc" and "PENDING" defaults for empty Ref/Status before encoding.
func SerializeYAML(d AiBlockData) string {
	if d.Ref == "" {
		d.Ref = "doc"
	}
	if d.Status == "" {
		d.Status = "PENDING"
	}
	s, _ := fencedblock.SerializeYaml(d)
	return s
}

// InsertAfterRef inserts pendingFence into body immediately after the block
// identified by ref. See fencedblock.InsertAfterRef for full semantics.
var InsertAfterRef = fencedblock.InsertAfterRef
