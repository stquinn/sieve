package gen

import (
	"bytes"
	"strings"

	"gopkg.in/yaml.v3"
)

// yamlMap is a mapping that keeps the order it was written in. The specs are
// read by humans as much as by tools, so `openapi:` comes before `info:` and a
// schema's `type` before its `properties` — an order a Go map cannot promise and
// which, left to the marshaller, would also reshuffle between toolchain
// versions.
type yamlMap struct {
	nodes []*yaml.Node
}

func newYAMLMap() *yamlMap { return &yamlMap{} }

// Set appends one entry. A nil or empty value is DROPPED rather than emitted as
// null, so an absent part of the contract leaves no trace in the spec.
func (m *yamlMap) Set(key string, value any) *yamlMap {
	node := m.value(value)
	if node == nil {
		return m
	}
	m.nodes = append(m.nodes,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		node)
	return m
}

func (m *yamlMap) value(value any) *yaml.Node {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		if v == "" {
			return nil
		}
		node := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
		// A multi-line description reads as a literal block; a single line stays
		// inline, and yaml.v3 picks its own quoting for either.
		if strings.Contains(v, "\n") {
			node.Style = yaml.LiteralStyle
		}
		return node
	case bool:
		word := "false"
		if v {
			word = "true"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: word}
	case *yamlMap:
		if v == nil {
			return nil
		}
		return &yaml.Node{Kind: yaml.MappingNode, Content: v.nodes}
	case []*yamlMap:
		if len(v) == 0 {
			return nil
		}
		seq := &yaml.Node{Kind: yaml.SequenceNode}
		for _, item := range v {
			seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.MappingNode, Content: item.nodes})
		}
		return seq
	case []string:
		if len(v) == 0 {
			return nil
		}
		seq := &yaml.Node{Kind: yaml.SequenceNode}
		for _, item := range v {
			seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: item})
		}
		return seq
	default:
		return nil
	}
}

// Encode renders the mapping as a YAML document, indented two spaces per level.
func (m *yamlMap) Encode() ([]byte, error) {
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.MappingNode, Content: m.nodes}); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// YAML renders one schema node. A $ref carries nothing but the reference: a
// sibling description on a ref is legal in 2020-12 but not in every reader, and
// the description is on the component anyway.
func (s *Schema) YAML() *yamlMap {
	out := newYAMLMap()
	if s == nil {
		return out
	}
	if s.Ref != "" {
		return out.Set("$ref", s.Ref)
	}
	if s.Any {
		// An unconstrained value is `{}` — but a description still says what that
		// value is FOR, and for an Any field the prose is the only contract there is,
		// so dropping it would leave the reader nothing at all.
		return out.Set("description", s.Description)
	}
	out.Set("type", s.Type)
	out.Set("description", s.Description)
	out.Set("enum", s.Enum)
	if s.Items != nil {
		out.Set("items", s.Items.YAML())
	}
	if len(s.Properties) > 0 {
		properties := newYAMLMap()
		for _, p := range s.Properties {
			properties.Set(p.Name, p.Schema.YAML())
		}
		out.Set("properties", properties)
	}
	out.Set("required", s.Required)
	if s.Values != nil {
		out.Set("additionalProperties", s.Values.YAML())
	}
	return out
}
