package requesthandlers

import (
	"strings"

	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/protocol"
)

// documentContent assembles a container as the editor mounts it. Two transports
// ask for the same thing — the document wire's load frame for a note or a block
// container, HTTP for a prompt pseudo-document, which opens no channel — so the
// assembly lives on one type rather than once per handler.
type documentContent struct {
	sp *sieve.ServiceProvider
}

// read returns the content for uuid, or false when nothing is stored under it.
// A prompt id (prompt:{name}) resolves to its raw text in markdown mode; a note
// resolves THROUGH the shadow, which mints prose handles, so the editor and the
// shadow share block identity from the first render; a block container or any
// other node the editor opens resolves to its one block, through the same open
// session its channel reads.
func (c documentContent) read(uuid string) (protocol.DocumentContent, bool) {
	tab := c.tab(uuid)

	if name, isPrompt := strings.CutPrefix(uuid, "prompt:"); isPrompt {
		body, err := c.sp.Prompts.GetPromptContent(name)
		if err != nil {
			return protocol.DocumentContent{}, false
		}
		return protocol.DocumentContent{Body: body, Mode: "markdown", UUID: uuid, Kind: domain.TabKindPrompt, Scroll: tab.Scroll}, true
	}

	if !tab.IsDocument() {
		return c.readContainer(uuid, tab)
	}
	doc, err := c.sp.Documents.LoadByUUID(uuid)
	if err != nil {
		return c.readContainer(uuid, tab)
	}
	mode := doc.Meta().All()["mode"]
	if mode == "" {
		mode = "wysiwyg"
	}
	content := protocol.DocumentContent{
		Body:       string(doc.Body()),
		Mode:       mode,
		UUID:       doc.UUID(),
		Kind:       string(doc.Kind()),
		Scroll:     tab.Scroll,
		Version:    doc.Meta().Version(),
		Presenting: tab.Presenting,
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

// readContainer returns the content of uuid as the one block the editor opens it
// to — a block container's, at its version, or another node's, unversioned — or
// false when the editor opens nothing there.
func (c documentContent) readContainer(uuid string, tab domain.Tab) (protocol.DocumentContent, bool) {
	if err := c.sp.Editor.Open(uuid); err != nil {
		return protocol.DocumentContent{}, false
	}
	blocks, ok := c.sp.Editor.FrontendBlocks(uuid)
	if !ok || len(blocks) != 1 {
		return protocol.DocumentContent{}, false
	}
	content := protocol.DocumentContent{
		Mode:   "wysiwyg",
		UUID:   uuid,
		Kind:   blocks[0].Kind,
		Scroll: tab.Scroll,
		Blocks: blocks,
	}
	if version, stored := c.sp.Editor.ContainerVersion(uuid); stored {
		content.Version = version
	}
	return content, true
}

// tab is uuid's session tab, or the zero Tab when there is none — a tab never
// opened parks at the top, is not presenting and is read as a document, the same
// as a tab saved before tabs carried a kind.
func (c documentContent) tab(uuid string) domain.Tab {
	if c.sp.State == nil {
		return domain.Tab{}
	}
	tab, _ := c.sp.State.LoadSession().Tab(uuid)
	return tab
}
