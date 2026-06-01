package filestore

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// parseFrontmatter splits a YAML frontmatter block from the document body.
// Used by createMeta to parse seed metadata from a body passed by callers
// (e.g. defaultMetaBody in the service layer) and by the migration tool.
//
// If no frontmatter block is present, an empty meta map and the full data as
// body are returned without error.
//
// Values are read as raw scalars via yaml.Node — no YAML type coercion.
// This preserves timestamps (e.g. "2026-05-22T10:00:00Z") and null literals
// as their original strings, avoiding the data-corruption bug that arose when
// yaml.v2 decoded timestamps into time.Time and fmt.Sprintf produced a
// different format.
func parseFrontmatter(data []byte) (meta map[string]string, body []byte, err error) {
	if len(data) == 0 {
		return map[string]string{}, []byte{}, nil
	}
	content := string(data)
	if !strings.HasPrefix(content, "---\n") {
		return map[string]string{}, data, nil
	}

	const open = 4
	closingSeq := "\n---\n"
	idx := strings.Index(content[open:], closingSeq)
	if idx == -1 {
		closingSeq = "\n---"
		idx = strings.Index(content[open:], closingSeq)
		if idx == -1 {
			return map[string]string{}, data, nil
		}
	}

	fmContent := content[open : open+idx]
	afterClose := content[open+idx+len(closingSeq):]
	afterClose = strings.TrimLeft(afterClose, "\n")
	body = []byte(afterClose)

	var root yaml.Node
	if err := yaml.Unmarshal([]byte(fmContent), &root); err != nil {
		return nil, nil, fmt.Errorf("filestore: parse frontmatter: %w", err)
	}

	meta = make(map[string]string)
	if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
		mapNode := root.Content[0]
		for i := 0; i+1 < len(mapNode.Content); i += 2 {
			key := mapNode.Content[i].Value
			meta[key] = nodeToString(mapNode.Content[i+1])
		}
	}
	return meta, body, nil
}

// nodeToString converts a yaml.Node to its string representation without type
// coercion. Scalars return their raw Value; sequences are rendered as inline
// lists ("[a, b, c]") to match the format expected by mapToDocMeta.
func nodeToString(n *yaml.Node) string {
	switch n.Kind {
	case yaml.ScalarNode:
		return n.Value
	case yaml.SequenceNode:
		if len(n.Content) == 0 {
			return "[]"
		}
		parts := make([]string, len(n.Content))
		for i, child := range n.Content {
			parts[i] = nodeToString(child)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	default:
		return n.Value
	}
}

// DiagnosticParse is an exported wrapper for parseFrontmatter used in
// troubleshooting scripts.
func DiagnosticParse(data []byte) (map[string]string, []byte, error) {
	return parseFrontmatter(data)
}
