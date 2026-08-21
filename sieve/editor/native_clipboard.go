package editor

import (
	"mime"

	"sieve/logger"
	"sieve/sieve/block"
)

// NativeClipboardPort reads the OS clipboard in the UI process, outside the
// webview. It is an interface here because the concrete reader is cgo over GTK
// (`clipboard/`) and this package must stay buildable — and testable — with cgo
// off; the composition root supplies the real one.
//
// Entries answers AT MOST ONE content view, probed in priority order: a raster
// image, else a file-copy's uri-list, else nothing. An empty clipboard, an
// unreadable offer and a read that never came back all answer no entries and no
// error, because a paste treats all three the same way.
type NativeClipboardPort interface {
	Entries() ([]block.ContentEntry, error)
}

// SetNativeClipboard registers who reads the OS clipboard. Nil leaves
// HandleNativeClipboard doing nothing, which is what a build with no desktop
// (tests, cgo off) gets.
func (es *EditorService) SetNativeClipboard(c NativeClipboardPort) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.clipboard = c
}

// HandleNativeClipboard makes a block out of whatever the OS clipboard is
// holding, at index.
//
// It exists because WebKitGTK hands the page a paste event whose DataTransfer is
// COMPLETELY EMPTY for a screenshot copied by an ordinary desktop tool — no
// types, no items, no files (#87). The page cannot salvage that, so the EMPTINESS
// is the signal: the client forwards the gesture and the caret, and the server
// reads the clipboard for itself.
//
// SECURITY: this reads the user's clipboard, and a uri-list on it reads local
// files, on the say-so of a wire frame. WsHandler's origin allow-list is what
// keeps a foreign page from opening that socket; auth-on-upgrade (#83) is the
// other half and is not built yet.
//
// What the clipboard turns out to hold decides nothing beyond which ingestion it
// takes — both of them already exist. A copied FILE is the same ingestion a
// dropped file takes (paths, the stat ceiling, one block per file); an IMAGE is
// an ordinary paste, so the registry claims it for smart-image exactly as a
// browser's copy-image does.
func (es *EditorService) HandleNativeClipboard(uuid string, index int) block.PasteResult {
	es.mu.RLock()
	clip := es.clipboard
	es.mu.RUnlock()
	if clip == nil {
		return block.PasteNothing()
	}
	entries, err := clip.Entries()
	if err != nil {
		logger.Warn("native-clipboard: read failed", "uuid", uuid, "err", err)
		return block.PasteNothing()
	}
	if len(entries) == 0 {
		return block.PasteNothing()
	}
	if base, _, err := mime.ParseMediaType(entries[0].MIMEType); err == nil && base == "text/uri-list" {
		return es.HandleNativeDrop(uuid, entries, index)
	}
	return es.HandlePaste(uuid, entries, index)
}
