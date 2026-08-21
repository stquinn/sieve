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
const pendingDropWait = 2 * time.Second

// SetPendingDrops registers the native drop bucket. Nil means a frame with no
// readable entries redeems nothing, which is what tests and non-desktop builds
// get.
func (es *EditorService) SetPendingDrops(s PendingDropSource) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.pendingDrops = s
}

// HandleNativeDrop ingests files named by a `text/uri-list`, one block per file.
//
// It exists because a WebKitGTK webview never materialises a readable File for a
// file-manager drag: all the page receives is the `text/uri-list` the OS put on
// the drag, so the bytes can only be read here. The frontend forwards that view
// verbatim and decides nothing beyond WHERE the drop landed.
//
// It is also where a COPIED file lands (HandleNativeClipboard, #87): a file
// manager offers the same uri-list either way, and "the entries name local files"
// is the whole of what this reads — the gesture that produced them is not its
// business.
//
// SECURITY: this reads local files named by a wire frame, so the document socket
// carries a filesystem-read capability. WsHandler's origin allow-list is what
// keeps a foreign page from opening that socket; auth-on-upgrade (#83) is the
// other half and is not built yet.
//
// A file that cannot be read is skipped rather than failing the whole drop — a
// drag of five files where one has since been moved should still land the four.
// Every file skipped leaves the outcome as PasteNothing, which is exactly what a
// drop of nothing readable did before it reached Go.
func (es *EditorService) HandleNativeDrop(uuid string, entries []block.ContentEntry, index int) block.PasteResult {
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

	files := es.droppedFiles(entries)
	if len(files) == 0 {
		// No entry named a file — the webview could read nothing of the drop (its
		// lenses starve on WebKitGTK, and each source app starves them differently:
		// #86). The gesture is still real, so ask the native bucket for the paths
		// GTK caught.
		es.mu.RLock()
		bucket := es.pendingDrops
		es.mu.RUnlock()
		if bucket != nil {
			for _, p := range bucket.TakeDrop(pendingDropWait) {
				files = append(files, droppedFile(p))
			}
		}
	}

	ceiling := es.attachmentCeiling()
	created := 0
	for _, f := range files {
		entry, ok := f.entry(ceiling)
		if !ok {
			continue
		}
		// Each file takes the ordinary paste route, so the registry decides its kind
		// exactly as it would for a paste: image/* to smart-image, everything else to
		// attachment. Created at index+created, so the blocks land in drag order.
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
	// A drop may create several blocks and therefore names none of them, for the
	// reason a slice paste does not: there is no single block for the caret's
	// empty-paragraph anchor to be consumed against. The outcome alone says the
	// server took the drop.
	return block.PasteBlock("", "", "")
}

// droppedFiles reads the paths out of a drop's views. Only the `text/uri-list`
// view names files; a native drag carries other flavours (`text/html`, a display
// name) that describe the same drop without addressing it.
func (es *EditorService) droppedFiles(entries []block.ContentEntry) []droppedFile {
	var files []droppedFile
	for _, e := range entries {
		base, _, err := mime.ParseMediaType(e.MIMEType)
		if err != nil {
			continue
		}
		switch base {
		case "text/uri-list":
			files = append(files, uriList(e.Content).files()...)
		case "text/html":
			// WebKitGTK's one readable drop lens (#86): getData answers '' for
			// text/uri-list, URL and text/plain on a real drag, and the store is
			// empty before any async read runs — but text/html survives, carrying
			// the file URI as an anchor's href. The frontend forwards it verbatim;
			// the extraction lives here with the rest of the path handling.
			files = append(files, dropMarkup(e.Content).files()...)
		}
	}
	return files
}

// dropMarkup is a `text/html` drop payload. The URI may live in an anchor's
// href OR as the anchor's TEXT — WebKitGTK writes the latter for a Dolphin drag
// (measured: a style-only <a> whose text is the file:/// URI, no href at all) —
// so the scan is for file: URIs anywhere in the markup, not for attributes.
type dropMarkup string

// files reports the local paths this markup names, in document order, under the
// same rules as a uri-list: only local `file:` URIs count.
func (h dropMarkup) files() []droppedFile {
	var uris []string
	rest := string(h)
	for {
		i := strings.Index(rest, "file:")
		if i == -1 {
			break
		}
		tail := rest[i:]
		end := strings.IndexAny(tail, " \t\r\n\"'<>")
		if end == -1 {
			end = len(tail)
		}
		// &amp; is the one entity legal inside a URI in markup that changes its
		// meaning when left encoded.
		uris = append(uris, strings.ReplaceAll(tail[:end], "&amp;", "&"))
		rest = tail[end:]
	}
	return uriList(strings.Join(uris, "\r\n")).files()
}

// attachmentCeiling is the live ceiling for files this drop may read — the
// user's setting when the editor is wired with a state port, the default in
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
