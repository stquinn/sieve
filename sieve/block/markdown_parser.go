package block

import (
	"regexp"
)

var (
	// inlineBlockRegex matches [!kind] { "json":"here" } [!somekind-end] — the
	// on-disk form written by InlineSerializer.Serialize and read by sieve-block-extension.js.
	inlineBlockRegex = regexp.MustCompile(`^\[!([A-Za-z0-9_-]+)\]\s*(\{.*?\})\s*\[!([A-Za-z0-9_-]+)-end\]`)
)
