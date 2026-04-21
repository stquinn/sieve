package filestore

import (
	"bytes"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v2"
)

// canonicalKeyOrder defines the field order used when writing YAML frontmatter.
// This matches the field order produced by the existing newBufferMeta template
// so that existing files are not needlessly reformatted on first save.
// Unknown keys are appended after all canonical keys, sorted alphabetically.
var canonicalKeyOrder = []string{
	"uuid", "status", "version", "focus_count", "user_intent",
	"ai_eval", "ai_last_evaluated", "ai_folder_suggestion",
	"user_suggested_name", "display_name", "filename", "summary",
	"tags", "assets", "ai_justification", "density_signals",
	"created", "modified", "cli", "ai_keep", "scroll",
}

// parseFrontmatter splits a YAML frontmatter block from the document body.
// It accepts content of the form:
//
//	---
//	key: value
//	---
//	body...
//
// If no frontmatter block is present, an empty meta map and the full data as
// body are returned without error.
//
// All YAML scalar values are converted to their string representations. Lists
// and null are preserved as inline YAML notation (e.g. "[]", "[a, b]", "null")
// so that they round-trip through DocumentMeta accessors in the business layer.
func parseFrontmatter(data []byte) (meta map[string]string, body []byte, err error) {
	content := string(data)

	// Require the opening delimiter as the very first bytes.
	if !strings.HasPrefix(content, "---\n") {
		return map[string]string{}, data, nil
	}

	// Locate the closing delimiter. It must be on its own line.
	const open = 4 // len("---\n")
	closingSeq := "\n---\n"
	idx := strings.Index(content[open:], closingSeq)
	if idx == -1 {
		// Accept a closing delimiter at end-of-file without trailing newline.
		closingSeq = "\n---"
		idx = strings.Index(content[open:], closingSeq)
		if idx == -1 {
			return map[string]string{}, data, nil
		}
	}

	fmContent := content[open : open+idx]
	afterClose := content[open+idx+len(closingSeq):]
	// Strip at most one leading newline so the body starts cleanly.
	afterClose = strings.TrimLeft(afterClose, "\n")
	body = []byte(afterClose)

	// Parse the YAML block. yaml.v2 decodes into map[interface{}]interface{}.
	var raw map[interface{}]interface{}
	if err := yaml.Unmarshal([]byte(fmContent), &raw); err != nil {
		return nil, nil, fmt.Errorf("filestore: parse frontmatter: %w", err)
	}

	meta = make(map[string]string, len(raw))
	for k, v := range raw {
		meta[fmt.Sprintf("%v", k)] = yamlValueToString(v)
	}
	return meta, body, nil
}

// yamlValueToString converts a value decoded by yaml.v2 into a string that can
// be written back to a YAML frontmatter file and parsed again identically.
//
// The conversion rules preserve the round-trip:
//   - nil          → "null"
//   - bool         → "true" / "false"
//   - integers     → decimal string
//   - floats       → %g decimal
//   - []interface{} → inline YAML list ("[a, b]" or "[]")
//   - string       → as-is
//   - other        → fmt.Sprint fallback
func yamlValueToString(v interface{}) string {
	if v == nil {
		return "null"
	}
	switch val := v.(type) {
	case string:
		return val
	case bool:
		if val {
			return "true"
		}
		return "false"
	case int:
		return fmt.Sprintf("%d", val)
	case int64:
		return fmt.Sprintf("%d", val)
	case float64:
		return fmt.Sprintf("%g", val)
	case []interface{}:
		if len(val) == 0 {
			return "[]"
		}
		parts := make([]string, len(val))
		for i, item := range val {
			parts[i] = yamlValueToString(item)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	default:
		return fmt.Sprintf("%v", val)
	}
}

// serialiseFrontmatter produces a complete document byte slice: a YAML
// frontmatter block followed by the plain body.
//
// Known keys are written in canonicalKeyOrder. Unknown keys follow,
// sorted alphabetically for deterministic output.
func serialiseFrontmatter(meta map[string]string, body []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString("---\n")

	written := make(map[string]bool, len(canonicalKeyOrder))
	for _, k := range canonicalKeyOrder {
		if v, ok := meta[k]; ok {
			written[k] = true
			writeFMLine(&buf, k, v)
		}
	}

	// Unknown keys — append in sorted order.
	var extra []string
	for k := range meta {
		if !written[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		writeFMLine(&buf, k, meta[k])
	}

	buf.WriteString("---\n")
	buf.Write(body)
	return buf.Bytes()
}

// writeFMLine writes a single "key: value\n" line to buf.
// Values that came from yamlValueToString are already valid YAML scalars or
// inline sequences and can be written verbatim.
func writeFMLine(buf *bytes.Buffer, key, value string) {
	buf.WriteString(key)
	buf.WriteString(": ")
	buf.WriteString(value)
	buf.WriteByte('\n')
}
