package block

import (
	"encoding/json"
	"fmt"
	"regexp"
)

var (
	// inlineBlockRegex matches [!kind] { "json":"here" } [!somekind-end] — the
	// on-disk form written by serializeInlineBlock and read by sieve-block-extension.js.
	inlineBlockRegex = regexp.MustCompile(`^\[!([A-Za-z0-9_-]+)\]\s*(\{.*?\})\s*\[!([A-Za-z0-9_-]+)-end\]`)
)

// serializeInlineBlock renders an inline-mode block as [!kind] {json} [!kind-end]
// — the form sieve-block-extension.js reads back on the frontend. It is owned by
// InlineSerializer, which inline-mode flavours embed.
func serializeInlineBlock(block SieveBlock) (string, error) {
	b, err := json.Marshal(block.Attrs)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("[!%s] %s [!%s-end]", block.Kind, string(b), block.Kind), nil
}

// ParseFirstBlock parses markdown and returns the first structured (non-prose)
// SieveBlock found, or nil if the content contains no structured block.
// Callers use this to unpack clipboard entries whose MIME type signals a Sieve
// block payload (e.g. "sieve/code", "sieve/diagram", "sieve/log").
// The DocumentCodec drives recognition via the global registry so the same
// processors that deserialize documents are reused here — no second parse path.
func ParseFirstBlock(markdown string) *SieveBlock {
	codec := NewDocumentCodec(GlobalRegistry())
	blocks, err := codec.Deserialize(markdown)
	if err != nil {
		return nil
	}
	for i := range blocks {
		if blocks[i].Kind != KindProse {
			return &blocks[i]
		}
	}
	return nil
}

// FindBlockByID parses markdown and returns the SieveBlock whose ID matches id,
// or (SieveBlock{}, false) if not found. Used as a fallback in BuildContextForID
// when the document is in markdown mode and its blocks tree is not populated.
// The DocumentCodec drives recognition via the global registry.
func FindBlockByID(markdown string, id string) (SieveBlock, bool) {
	codec := NewDocumentCodec(GlobalRegistry())
	blocks, err := codec.Deserialize(markdown)
	if err != nil {
		return SieveBlock{}, false
	}
	for _, b := range blocks {
		if b.ID == id {
			return b, true
		}
	}
	return SieveBlock{}, false
}
