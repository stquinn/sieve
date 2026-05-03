package filestore

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v2"
)

// parseFrontmatter splits a YAML frontmatter block from the document body.
// Used by createMeta to parse seed metadata from a body passed by callers
// (e.g. defaultMetaBody in the service layer) and by the migration tool.
//
// If no frontmatter block is present, an empty meta map and the full data as
// body are returned without error.
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

// DiagnosticParse is an exported wrapper for parseFrontmatter used in
// troubleshooting scripts.
func DiagnosticParse(data []byte) (map[string]string, []byte, error) {
	return parseFrontmatter(data)
}
