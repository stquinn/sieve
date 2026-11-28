package block

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"

	"gopkg.in/yaml.v3"

	"sieve/sieve/domain"
)

// The keys of a chat's content file.
const (
	chatKindKey      = "kind"
	chatExchangesKey = "exchanges"
)

// ChatCodec reads and writes a chat's content file. The file is one YAML map
// that opens with `kind: chat`, followed by `exchanges`: the chat's ai-blocks in
// order, each the map its fence would hold inside a document, written and read by
// the registry's map writer and reader (Registry.WriteMap, Registry.ReadMap). It
// holds no fences, no frontmatter and no markdown.
//
//	kind: chat
//	exchanges:
//	    - answer:
//	        - attrs:
//	            content: A list of exchanges.
//	            id: 01a21eb1-…
//	          kind: prose
//	      id: 01a21eb1-…
//	      question:
//	        - attrs:
//	            content: What is a chat?
//	            id: 01a21eb1-…
//	          kind: prose
//	      status: COMPLETE
type ChatCodec struct {
	registry Registry
}

// NewChatCodec builds the codec over the registry whose map writer and reader
// each exchange goes through.
func NewChatCodec(registry Registry) *ChatCodec {
	return &ChatCodec{registry: registry}
}

// Encode writes exchanges, in order, as a chat's content file. An exchange that
// is not an ai-block is refused and nothing is written.
func (c *ChatCodec) Encode(exchanges []domain.SieveBlock) ([]byte, error) {
	list := &yaml.Node{Kind: yaml.SequenceNode}
	for _, exchange := range exchanges {
		if exchange.Kind != KindAIBlock {
			return nil, fmt.Errorf("chat codec: exchange %s is a %q, not an %s", exchange.ID, exchange.Kind, KindAIBlock)
		}
		written, err := c.registry.WriteMap(exchange)
		if err != nil {
			return nil, fmt.Errorf("chat codec: exchange %s: %w", exchange.ID, err)
		}
		var doc yaml.Node
		if err := yaml.Unmarshal([]byte(written), &doc); err != nil || len(doc.Content) != 1 {
			return nil, fmt.Errorf("chat codec: exchange %s: its map does not read back: %v", exchange.ID, err)
		}
		list.Content = append(list.Content, doc.Content[0])
	}
	root := &yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{
		c.scalar(chatKindKey), c.scalar(domain.ChatKind),
		c.scalar(chatExchangesKey), list,
	}}
	out, err := c.encode(root)
	if err != nil {
		return nil, err
	}
	return []byte(out + "\n"), nil
}

// Decode reads a chat's content file into its exchanges, in order, each an
// ai-block. A body that is not one YAML document, one whose first key is not
// `kind: chat`, a key the file does not hold, and an exchange that is not a map
// are each refused.
func (c *ChatCodec) Decode(body []byte) ([]domain.SieveBlock, error) {
	dec := yaml.NewDecoder(bytes.NewReader(body))
	var doc, more yaml.Node
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("chat codec: parse: %w", err)
	}
	if err := dec.Decode(&more); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("chat codec: body is more than one YAML document")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("chat codec: body is not a map opening %s: %s", chatKindKey, domain.ChatKind)
	}
	pairs := doc.Content[0].Content
	if len(pairs) < 2 || pairs[0].Value != chatKindKey || pairs[1].Value != domain.ChatKind {
		return nil, fmt.Errorf("chat codec: body does not open %s: %s", chatKindKey, domain.ChatKind)
	}
	var exchanges []domain.SieveBlock
	for i := 2; i+1 < len(pairs); i += 2 {
		key, value := pairs[i].Value, pairs[i+1]
		if key != chatExchangesKey {
			return nil, fmt.Errorf("chat codec: unknown key %q", key)
		}
		if value.Kind != yaml.SequenceNode {
			return nil, fmt.Errorf("chat codec: %s is not a list", chatExchangesKey)
		}
		for n, item := range value.Content {
			exchange, err := c.decodeExchange(item)
			if err != nil {
				return nil, fmt.Errorf("chat codec: exchange %d: %w", n, err)
			}
			exchanges = append(exchanges, exchange)
		}
	}
	return exchanges, nil
}

// decodeExchange reads one entry of the exchanges list as an ai-block.
func (c *ChatCodec) decodeExchange(item *yaml.Node) (domain.SieveBlock, error) {
	if item.Kind != yaml.MappingNode {
		return domain.SieveBlock{}, fmt.Errorf("not a map")
	}
	written, err := c.encode(item)
	if err != nil {
		return domain.SieveBlock{}, err
	}
	return c.registry.ReadMap(KindAIBlock, written)
}

// encode renders a node as the fenced map writer does: four-space indentation, no
// trailing newline.
func (c *ChatCodec) encode(n *yaml.Node) (string, error) {
	var buf strings.Builder
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(4)
	if err := enc.Encode(n); err != nil {
		return "", fmt.Errorf("chat codec: encode: %w", err)
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("chat codec: encode: %w", err)
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// scalar is a plain string node.
func (c *ChatCodec) scalar(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}
