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
// file drop, caught at the GTK layer (Wails OnFileDrop). TakeDrop waits briefly,
// because the DOM's redeem and GTK's callback race on the same gesture.
type PendingDropSource interface {
	TakeDrop(maxWait time.Duration) []string
}

// pendingDropWait bounds how long a redeem waits for GTK's half of the gesture.
// It runs its full length only for sources GTK cannot see (VSCode), where the
// page hint takes over, so it is the lag those drops feel.
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
// The frame that lands here carries ONLY the index — the drop content itself is
// redeemed from the native bucket, on every platform. The wait absorbs the race
// between the DOM's frame and the native callback, which land in no guaranteed
// order.
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
	// BUCKET FIRST, page hint second: some source apps (VSCode) offer no file URI
	// at any layer and put the bare path on plain text instead. os.Stat is the
	// validator — text naming no real file ingests nothing.
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
// A file that cannot be read is skipped rather than failing the whole batch.
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
	// be consumed against, so none is named.
	return block.PasteBlock("", "", "")
}

// pageHint is what the page could read of a drop the native side missed: a
// text/uri-list, or plain text carrying bare absolute paths (VSCode's dialect).
type pageHint []block.ContentEntry

// files reports the local paths the hint names. Bare `/abs/path` lines are
// accepted alongside file: URIs; a path is only ingested after os.Stat says it
// is a real regular file.
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
// ONLY `file:` URIs are returned — a link dragged out of a browser rides this
// same flavour — so a caller must not read "the list is empty" as "the drop was
// malformed".
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
		// this machine. "localhost" is the one spelling that means this machine.
		if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
			continue
		}
		// u.Path is the percent-DECODED path: reading u.RawPath (or the line
		// itself) would look for a filename containing a literal percent sign.
		out = append(out, droppedFile(u.Path))
	}
	return out
}

// droppedFile is one local path a native drop named.
type droppedFile string

// entry reads the file into the single content view the paste registry matches
// on: a data URI carrying the bytes, with the original filename in Context. Both
// halves are load-bearing — a data URI carries the bytes and not the name, and a
// consumer that cannot name a file refuses the entry.
//
// The size is asked BEFORE the bytes are, so a file over the ceiling never
// enters memory. The ceiling is the user's setting, normalised in one place
// (Settings.AttachmentCeilingBytes).
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

// mimeType is what this file declares itself to be. The EXTENSION is asked first
// and the bytes second, because sniffing answers "text/plain" for YAML, JSON and
// every other structured text, and the type reaches a paste matcher that
// compares it.
func (f droppedFile) mimeType(data []byte) string {
	if t := f.baseType(mime.TypeByExtension(filepath.Ext(string(f)))); t != "" {
		return t
	}
	if t := f.baseType(http.DetectContentType(data)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// baseType drops the parameters ("; charset=utf-8") a mime type may carry: the
// type is written into a data URI and compared by prefix in paste matchers.
func (f droppedFile) baseType(t string) string {
	base, _, err := mime.ParseMediaType(t)
	if err != nil {
		return ""
	}
	return base
}
