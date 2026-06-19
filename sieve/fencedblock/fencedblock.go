package fencedblock

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// SerializeYaml encodes v as YAML with 4-space indentation using yaml.v3.
// All multiline strings are forced to literal block style (|) regardless of
// content — this prevents yaml.v3 from choosing double-quoted style for
// strings that begin with backticks or other "tricky" characters.
// 4-space indent ensures block scalar content can never trigger a closing
// fence (CommonMark allows fences with 0–3 leading spaces only).
func SerializeYaml[T any](v T) (string, error) {
	// Marshal to bytes, then unmarshal to a Node tree so we can override
	// yaml.v3's automatic style choices for multiline strings.
	raw, err := yaml.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("fencedblock: serialize marshal: %w", err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return "", fmt.Errorf("fencedblock: serialize unmarshal: %w", err)
	}
	forceLiteralStyle(&doc)

	var buf strings.Builder
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(4)
	if err := enc.Encode(&doc); err != nil {
		return "", fmt.Errorf("fencedblock: serialize encode: %w", err)
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// DeserializeYaml is the inverse of SerializeYaml: it parses a fenced block's
// YAML body back into an attribute bag. Kept here so the fenced SerDes lives in
// one package.
func DeserializeYaml(body string) (map[string]interface{}, error) {
	var attrs map[string]interface{}
	if err := yaml.Unmarshal([]byte(body), &attrs); err != nil {
		return nil, err
	}
	if attrs == nil {
		attrs = map[string]interface{}{}
	}
	return attrs, nil
}

// forceLiteralStyle walks a yaml.Node tree and sets literal block style on
// every multiline string scalar. yaml.v3 defaults to double-quoted style for
// strings that begin with backticks or contain other YAML-special sequences;
// literal style produces cleaner, human-readable output.
func forceLiteralStyle(n *yaml.Node) {
	if n.Kind == yaml.ScalarNode && n.Tag == "!!str" && strings.Contains(n.Value, "\n") {
		n.Style = yaml.LiteralStyle
	}
	for _, child := range n.Content {
		forceLiteralStyle(child)
	}
}
