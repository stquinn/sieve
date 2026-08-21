package requesthandlers

import (
	"strings"

	"sieve/sieve"
	"sieve/sieve/protocol"
)

// documentContent assembles a document as the editor mounts it. Two transports
// ask for the same thing — the document wire's load frame for a note, HTTP for a
// prompt pseudo-document, which opens no channel — so the assembly lives on one
// type rather than once per handler.
type documentContent struct {
	sp *sieve.ServiceProvider
}

// read returns the content for uuid, or false when nothing is stored under it.
// A prompt id (prompt:{name}) resolves to its raw text in markdown mode; a note
// resolves THROUGH the shadow, which mints prose handles, so the editor and the
// shadow share block identity from the first render.
func (c documentContent) read(uuid string) (protocol.DocumentContent, bool) {
	scroll := c.scroll(uuid)

	if name, isPrompt := strings.CutPrefix(uuid, "prompt:"); isPrompt {
		body, err := c.sp.Prompts.GetPromptContent(name)
		if err != nil {
			return protocol.DocumentContent{}, false
		}
		return protocol.DocumentContent{Body: body, Mode: "markdown", UUID: uuid, Scroll: scroll}, true
	}

	doc, err := c.sp.Documents.LoadByUUID(uuid)
	if err != nil {
		return protocol.DocumentContent{}, false
	}
	mode := doc.Meta().All()["mode"]
	if mode == "" {
		mode = "wysiwyg"
	}
	content := protocol.DocumentContent{
		Body:    string(doc.Body()),
		Mode:    mode,
		UUID:    doc.UUID(),
		Scroll:  scroll,
		Version: doc.Meta().Version(),
	}
	// WYSIWYG renders from the block list, so ensuring the shadow here is the
	// identity step: whichever of this read and the document channel comes first
	// mints the ids, and the other reuses that same shadow. Markdown mode serves
	// the raw body only — the client never builds blocks there.
	if mode != "markdown" {
		_ = c.sp.Editor.Open(uuid)
		if blocks, ok := c.sp.Editor.FrontendBlocks(uuid); ok {
			content.Blocks = blocks
		}
	}
	return content, true
}

// scroll is the tab's saved offset, or 0 when the tab has none — a tab never
// opened and a tab never scrolled both park at the top, so they need no
// distinction.
func (c documentContent) scroll(uuid string) int {
	if c.sp.State == nil {
		return 0
	}
	for _, t := range c.sp.State.LoadSession().Tabs {
		if t.ID == uuid {
			return t.Scroll
		}
	}
	return 0
}
