package editor

import (
	"encoding/base64"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// PendingDropSource is the native drop BUCKET: the paths of the most recent OS
// file drop, caught at the GTK layer (Wails OnFileDrop), waited on briefly
// because the DOM's redeem and GTK's callback race on the same gesture. An
// interface for the same reason NativeClipboardPort is one: the concrete bucket
// lives above this package, and tests supply fakes.
type PendingDropSource interface {
	TakeDrop(maxWait time.Duration) []string
}

// pendingDropWait bounds how long a redeem waits for GTK's half of the gesture.
// The callback, when it fires at all, lands within milliseconds of the DOM's
// frame (they are one gesture); the wait only ever runs its full length for
// sources GTK cannot see (VSCode), where the page hint takes over — so this is
// the LAG such drops feel, and it stays short.
const pendingDropWait = 500 * time.Millisecond

// SetPendingDrops registers the native drop bucket. Nil means a frame with no
// readable entries redeems nothing, which is what tests and non-desktop builds
// get.
func (es *EditorService) SetPendingDrops(s PendingDropSource) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.pendingDrops = s
}

// HandleNativeDrop makes blocks out of the most recent OS file drop, at index.
//
// The frame that lands here carries ONLY the index: "there was a drop at this
// position and the page could read none of it — take it from the native drop
// bucket". That is the ONE drop mechanism on every platform (the ethos of the
// empty-clipboard paste, #87): WebKitGTK starves the page of drop content and
// every source app starves it differently, so the webview is never consulted —
// GTK/Cocoa catches the drop (Wails OnFileDrop) and this redeems it. The wait
// absorbs the race between the DOM's frame and the native callback, which land
// in no guaranteed order.
//
// SECURITY: the bucket is fed ONLY by the native drop callback, so the files
// read here are exactly the files the user just dropped — no path ever crosses
// the wire.
func (es *EditorService) HandleNativeDrop(uuid string, entries []block.ContentEntry, index int) block.PasteResult {
	es.mu.RLock()
	bucket := es.pendingDrops
	es.mu.RUnlock()

	var files []droppedFile
	if bucket != nil {
		for _, p := range bucket.TakeDrop(pendingDropWait) {
			files = append(files, droppedFile(p))
		}
	}
	// BUCKET FIRST, page hint second: some source apps (VSCode) never offer a
	// file URI at ANY layer — GTK included, so OnFileDrop cannot catch them — and
	// put the bare path on plain text instead. When the native side missed the
	// drop, whatever text the page could read is the only address there is.
	// os.Stat is the validator: text naming no real file ingests nothing.
	if len(files) == 0 {
		files = pageHint(entries).files()
		logger.Info("native drop: bucket empty, using page hint", "entries", len(entries), "files", len(files))
	}
	return es.ingestFiles(uuid, files, index)
}

// ingestFiles is the shared spine under both native gestures — a drop's bucket
// and a copied file's clipboard uri-list: one block per file, in order, from
// index, each through the ordinary paste route so the registry decides its kind.
//
// A file that cannot be read is skipped rather than failing the whole batch — a
// drop of five files where one has since been moved should still land the four.
// Everything skipped leaves the outcome as PasteNothing.
func (es *EditorService) ingestFiles(uuid string, files []droppedFile, index int) block.PasteResult {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("native files: no open document", "uuid", uuid)
		return block.PasteNothing()
	}
	if index < 0 {
		index = len(shadow.SnapshotBlocks())
	}

	ceiling := es.attachmentCeiling()
	created := 0
	for _, f := range files {
		entry, ok := f.entry(ceiling)
		if !ok {
			continue
		}
		res := es.HandlePaste(uuid, []block.ContentEntry{entry}, index+created)
		if !res.IsBlock() {
			logger.Warn("native files: file produced no block", "uuid", uuid, "outcome", res.Outcome)
			continue
		}
		created++
	}
	if created == 0 {
		return block.PasteNothing()
	}
	// Several blocks mean no single one for the caret's empty-paragraph anchor to
	// be consumed against, so none is named; the outcome alone says the server
	// took the drop.
	return block.PasteBlock("", "", "")
}

// pageHint is what the page could read of a drop the native side missed: a
// text/uri-list, or plain text carrying bare absolute paths (VSCode's dialect).
type pageHint []block.ContentEntry

// files reports the local paths the hint names. Bare `/abs/path` lines are
// accepted alongside file: URIs — a path is only ever ingested after os.Stat
// says it is a real regular file, so loose text costs nothing.
func (h pageHint) files() []droppedFile {
	var out []droppedFile
	for _, e := range h {
		for _, line := range strings.Split(e.Content, "\n") {
			line = strings.TrimSpace(line)
			switch {
			case line == "" || strings.HasPrefix(line, "#"):
			case strings.HasPrefix(line, "/"):
				out = append(out, droppedFile(line))
			default:
				out = append(out, uriList(line).files()...)
			}
		}
	}
	return out
}

// attachmentCeiling is the live ceiling for files a native gesture may read —
// the user's setting when the editor is wired with a state port, the default in
// constructions (tests) that have none.
func (es *EditorService) attachmentCeiling() int {
	if es.services.State == nil {
		return domain.DefaultMaxAttachmentBytes
	}
	return es.services.State.LoadSettings().AttachmentCeilingBytes()
}

// uriList is a `text/uri-list` payload as a desktop file drag delivers it: one
// URI per line, with blank lines and `#` comment lines allowed (RFC 2483 §5).
type uriList string

// files reports the local paths this list names, in drag order.
//
// ONLY `file:` URIs are returned. A link dragged out of a browser puts an http
// URL on this same flavour, and that is a link for the paste pipeline to make
// sense of, not a file to read off disk — which is also why a caller must not
// treat "the list is empty" as "the drop was malformed".
func (l uriList) files() []droppedFile {
	var out []droppedFile
	for _, line := range strings.Split(string(l), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || !strings.EqualFold(u.Scheme, "file") || u.Path == "" {
			continue
		}
		// A host names a remote share (file://server/share/x) that is not a path on
		// this machine. "localhost" is the one spelling that means this machine, and
		// GNOME writes it.
		if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
			continue
		}
		// u.Path is the percent-DECODED path: "a%20file.pdf" is a file called
		// "a file.pdf", and reading u.RawPath (or the line itself) would look for a
		// file whose name contains a literal percent sign.
		out = append(out, droppedFile(u.Path))
	}
	return out
}

// droppedFile is one local path a native drop named.
type droppedFile string

// entry reads the file into the single content view the paste registry matches
// on: a data URI carrying the bytes, with the original filename in Context.
//
// The shape is the one the browser's file branch produced before WebKitGTK's
// missing File objects forced the read into Go, and both halves are load-bearing.
// A data URI carries the bytes and NOTHING ELSE — not even what the file was
// called — so AttachmentProcessor.droppedFile refuses an entry it cannot name,
// and the chip would have nothing to label itself with.
//
// The size is asked BEFORE the bytes are, and that ordering is the point: this
// is the front half of the ceiling the browser used to enforce — keeping a file
// too big to hold out of memory entirely — and AttachmentProcessor's own check
// stays the backstop that does not trust a client. The ceiling is the user's
// setting (#84), normalised in ONE place (Settings.AttachmentCeilingBytes) so
// both halves refuse at the same number.
func (f droppedFile) entry(ceiling int) (block.ContentEntry, bool) {
	path := string(f)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		logger.Warn("native files: not a readable file", "path", path, "err", err)
		return block.ContentEntry{}, false
	}
	if info.Size() > int64(ceiling) {
		logger.Warn("native files: file over the attachment ceiling — not read",
			"path", path, "bytes", info.Size(), "limit", ceiling)
		return block.ContentEntry{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		logger.Warn("native files: read failed", "path", path, "err", err)
		return block.ContentEntry{}, false
	}
	mimeType := f.mimeType(data)
	return block.ContentEntry{
		MIMEType: mimeType,
		Content:  "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data),
		Context:  map[string]interface{}{"filename": filepath.Base(path)},
	}, true
}

// mimeType is what this file declares itself to be.
//
// The EXTENSION is asked first and the bytes second, because sniffing answers
// "text/plain" for YAML, JSON and every other structured text while an extension
// tells them apart — and the type reaches a paste matcher that compares it. The
// bytes are the fallback for a file with no extension at all.
func (f droppedFile) mimeType(data []byte) string {
	if t := f.baseType(mime.TypeByExtension(filepath.Ext(string(f)))); t != "" {
		return t
	}
	if t := f.baseType(http.DetectContentType(data)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// baseType drops the parameters ("; charset=utf-8") a mime type may carry. The
// type is written into a data URI and compared by prefix in paste matchers, and
// neither wants the parameters.
func (f droppedFile) baseType(t string) string {
	base, _, err := mime.ParseMediaType(t)
	if err != nil {
		return ""
	}
	return base
}
