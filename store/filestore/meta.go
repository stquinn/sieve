package filestore

import (
	"bytes"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v2"
)

var yamlLineErrRegex = regexp.MustCompile(`line (\d+):`)

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
	if data == nil || len(data) == 0 {
		return map[string]string{}, []byte{}, nil
	}
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
		fmt.Printf("[filestore] parse error: %v\n", err)
		// Attempt Auto-Resurrection for common "unquoted colon" errors.
		fixed, ok := tryFuzzyRepair(fmContent, err.Error())
		if ok {
			if err2 := yaml.Unmarshal([]byte(fixed), &raw); err2 == nil {
				fmt.Printf("[filestore] auto-resurrection successful for %q\n", meta["display_name"])
				// Resurrection successful!
				meta = make(map[string]string, len(raw)+1)
				for k, v := range raw {
					meta[fmt.Sprintf("%v", k)] = yamlValueToString(v)
				}
				meta["_recovery"] = "fixed YAML syntax error (resurrected)"
				return meta, body, nil
			} else {
				fmt.Printf("[filestore] auto-resurrection failed to parse fixed YAML: %v\n", err2)
			}
		}
		return nil, nil, fmt.Errorf("filestore: parse frontmatter: %w", err)
	}

	meta = make(map[string]string, len(raw))
	for k, v := range raw {
		meta[fmt.Sprintf("%v", k)] = yamlValueToString(v)
	}
	return meta, body, nil
}

// tryFuzzyRepair attempts to fix common YAML errors like unquoted colons or
// collapsed frontmatter lines. It returns (fixedContent, success).
func tryFuzzyRepair(content string, errMsg string) (string, bool) {
	fmt.Printf("[filestore] tryFuzzyRepair starting for error: %q\n", errMsg)
	// 1. Extract line number from error: "yaml: line X: ..."
	lineNum := 1
	match := yamlLineErrRegex.FindStringSubmatch(errMsg)
	if len(match) > 1 {
		if n, err := strconv.Atoi(match[1]); err == nil {
			lineNum = n
		}
	}
	fmt.Printf("[filestore] identified line for repair: %d\n", lineNum)

	// 2. Locate the broken line.
	lines := strings.Split(content, "\n")
	if lineNum < 1 || lineNum > len(lines) {
		fmt.Printf("[filestore] line number out of range: %d (max %d)\n", lineNum, len(lines))
		return "", false
	}

	lineIdx := lineNum - 1
	line := lines[lineIdx]
	fmt.Printf("[filestore] line content: %q\n", line)

	// 3. Heuristic: Un-flattener.
	// If the line contains multiple canonical keys (uuid:, status:, version:),
	// it was likely collapsed. Split them back into distinct lines.
	if strings.Count(line, ": ") > 1 {
		checkKeys := []string{"uuid:", "status:", "version:", "focus_count:", "user_intent:", "display_name:", "summary:", "tags:", "created:", "modified:"}
		foundKeys := 0
		tempLine := line
		for _, k := range checkKeys {
			if strings.Contains(line, k) {
				foundKeys++
				// Replace " key:" with "\nkey:" to un-flatten.
				tempLine = strings.ReplaceAll(tempLine, " "+k, "\n"+k)
			}
		}
		if foundKeys > 1 && tempLine != line {
			fmt.Printf("[filestore] un-flattening collapsed line: %d keys found\n", foundKeys)
			lines[lineIdx] = tempLine
			return strings.Join(lines, "\n"), true
		}
	}

	// 4. Heuristic: Quoting fix.
	// If it looks like 'key: some value: with: colons' and isn't already quoted.
	parts := strings.SplitN(line, ": ", 2)
	if len(parts) == 2 {
		key := parts[0]
		val := parts[1]
		if !strings.HasPrefix(val, "\"") && !strings.HasPrefix(val, "'") && strings.Contains(val, ":") {
			fmt.Printf("[filestore] applying quoting fix to key %q\n", key)
			// Wrap it in double quotes. Basic escaping of existing internal quotes.
			escapedVal := strings.ReplaceAll(val, "\"", "\\\"")
			lines[lineIdx] = fmt.Sprintf("%s: \"%s\"", key, escapedVal)
			return strings.Join(lines, "\n"), true
		}
	}

	fmt.Printf("[filestore] line did not match heuristic for auto-repair\n")
	return "", false
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
	// If the document is in an error state (e.g. frontmatter was corrupted),
	// the 'body' field contains the raw original file contents. We write it
	// back as-is so the user's manual repairs are preserved.
	if meta["status"] == "error" {
		return body
	}

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
// It uses yaml.Marshal for scalar strings to ensure proper quoting (e.g. for
// values containing colons), while preserving raw notation for null, booleans,
// and inline lists.
func writeFMLine(buf *bytes.Buffer, key, value string) {
	buf.WriteString(key)
	buf.WriteString(": ")

	// If it looks like a keyword or an inline list, write it raw to preserve
	// the internal wire format.
	if value == "null" || value == "true" || value == "false" || (strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]")) {
		buf.WriteString(value)
	} else {
		// Use the official YAML marshaller for scalar strings. This ensures that
		// a summary like "Task: Go" is correctly quoted as "Task: Go" (or similar).
		b, _ := yaml.Marshal(value)
		// yaml.Marshal appends a newline; trim it before writing.
		buf.Write(bytes.TrimSpace(b))
	}
	buf.WriteByte('\n')
}

// DiagnosticParse is an exported wrapper for parseFrontmatter to be used in
// troubleshooting scripts.
func DiagnosticParse(data []byte) (map[string]string, []byte, error) {
	return parseFrontmatter(data)
}
