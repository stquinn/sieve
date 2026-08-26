package processors

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// referenceSummaryChars caps a held file's excerpt: a summary is one line under
// a chip's title, not a preview pane.
const referenceSummaryChars = 200

// referenceExcerptBytes bounds how far into an asset the excerpt looks, so a
// 100MB log is not split line-by-line. A file whose first line is longer than
// this gets no excerpt at all.
const referenceExcerptBytes = 4096

// maxHeldBytes is the largest file this kind will hold — the server-side
// backstop for a ceiling the frontend also enforces before reading a file. It
// comes from the max_attachment_bytes setting; a processor built without a state
// port falls back to domain.DefaultMaxAttachmentBytes, never to no ceiling.
func (p *ReferenceProcessor) maxHeldBytes() int {
	if p.svc.State == nil {
		return domain.DefaultMaxAttachmentBytes
	}
	return p.svc.State.LoadSettings().AttachmentCeilingBytes()
}

// maxMaterialisedTextBytes caps the held file this kind will hand over as
// content for another block to be built from. It sits far below the hold ceiling
// because extracted content becomes editable document content; past this the
// file stays a chip.
const maxMaterialisedTextBytes = 256 * 1024

// referenceMaxExtLen bounds the suffix a stored asset inherits from a dropped
// filename, dot included: long enough for .markdown, short enough that a
// filename ending in a full stop contributes no extension.
const referenceMaxExtLen = 12

// ReferenceProcessor handles the 'reference' Kind — a chip that either HOLDS a
// file the document is about, or POINTS at something else Sieve can name.
//
// ONE ADDRESS, ONE DISCRIMINATOR. Every reference carries a `uri` and nothing
// else locates it — a held file's bytes live at
// sieve://{own-container}/{asset-key}. What separates the two halves is the
// FACE, not the address: `mime` is always stamped, and held ⇔ that mime is not a
// sieve/* type. An address is parsed once, in the resolve job; everything else
// reads the face.
//
// `rel` is a fence, not a feature: it records the relationship an author
// declared ("cites", "supersedes"). Nothing branches on it and no query filters
// on it — growing behaviour on it needs a design, not an if.
type ReferenceProcessor struct {
	svc                      block.BlockServices
	assets                   documentAssets // where a dropped file's bytes land
	block.FencedSerializer                  // one shared YAML serialization — free
	block.FencedDeserializer                // its mirror — recognise+parse the fenced form
}

// NewReferenceProcessor builds the kind. The "attachment" alias keeps older
// documents readable; such a fence canonicalises to "reference" on the next
// save.
func NewReferenceProcessor(svc block.BlockServices) *ReferenceProcessor {
	return &ReferenceProcessor{
		svc:                svc,
		assets:             documentAssets{svc: svc, kind: "reference"},
		FencedDeserializer: block.FencedDeserializer{Kind: "reference", Aliases: []string{"attachment"}},
	}
}

func (p *ReferenceProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *ReferenceProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *ReferenceProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":  id,
		"uri": "", // the one address, whether this block holds or points
		"rel": "", // the authored relationship; nothing branches on it
		// The cached face. mime is stamped for both halves — a real media type for
		// a held file, sieve/{kind} for a pointer.
		"title":             "",
		"summary":           "",
		"bytes":             "",
		"mime":              "",
		"status":            block.BlockStatusPending,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"completedAt":       "",
		"error":             "",
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	// Decided after the overrides: whether there is work to do is a fact about the
	// seeded block, not about the defaults.
	if p.resolvable(attrs) {
		attrs["status"] = block.BlockStatusPending
	} else {
		p.complete(attrs)
	}
	return attrs
}

// uri reads the block's one address attr.
func (p *ReferenceProcessor) uri(attrs map[string]interface{}) string {
	u, _ := attrs["uri"].(string)
	return strings.TrimSpace(u)
}

// resolvable reports that this block has an address whose face nobody has filled
// in yet. It is both the complete-vs-pending and the describes-a-job predicate,
// which BlockProcessor requires to agree.
//
// A reference always ends up carrying a mime, so an empty one is exactly the
// window between a coordinate arriving and its resolve landing. A block seeded
// with a face (a drop, an accepted @ mention) is born complete and is never
// re-armed.
func (p *ReferenceProcessor) resolvable(attrs map[string]interface{}) bool {
	mimeType, _ := attrs["mime"].(string)
	return p.uri(attrs) != "" && strings.TrimSpace(mimeType) == ""
}

// complete seals the face. status and completedAt must be stamped together — a
// block claiming COMPLETE with no time on it is self-contradictory on disk.
func (p *ReferenceProcessor) complete(attrs map[string]interface{}) {
	attrs["status"] = block.BlockStatusComplete
	attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
}

// held reports that this block holds the bytes its address names, rather than
// pointing at something else. THE FACE DECIDES: a pointer's mime is sieve/{kind}
// and a held file's is a real format. Never inspect the address to answer this —
// a block pointing at another document's asset looks exactly like one holding
// its own.
func (p *ReferenceProcessor) held(attrs map[string]interface{}) bool {
	mimeType, _ := attrs["mime"].(string)
	mimeType = strings.TrimSpace(mimeType)
	return mimeType != "" && !strings.HasPrefix(mimeType, "sieve/")
}

// heldAddress recovers where a held file's bytes are — the owning container and
// the asset key. It decides nothing about held-ness; `held` does that, from the
// face.
//
// The container comes from the address, never from the document being rendered,
// so a reference copied between documents still reaches the bytes it names.
func (p *ReferenceProcessor) heldAddress(attrs map[string]interface{}) (domain.Address, bool) {
	addr, err := domain.ParseAddress(p.uri(attrs))
	if err != nil || addr.Leaf == "" {
		return domain.Address{}, false
	}
	return addr, true
}

// IsSupportedContent claims the three ways content becomes a reference: a copied
// reference (paste + extract), a pasted Sieve coordinate (transform), and a
// dropped file (paste) — a drop runs the same paste-match pipeline a paste does,
// and this kind takes the files nobody else claims.
func (p *ReferenceProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if _, ok := p.pastedCoordinate(e); ok {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionTransform}}
		}
		// Paste alone: a dropped file is a creation, so it must not appear in the
		// extract menu.
		if _, ok := p.droppedFile(e); ok {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// droppedFile reports the ORIGINAL FILENAME an entry carries when it is a dropped
// file this kind will hold.
//
// A drop arrives as a data URI with the filename in Context, and both halves are
// required: a data URI carries the bytes and not the name, a name alone carries
// no bytes.
//
// Images are REFUSED so that smart-image, which claims image/*, wins without the
// answer depending on registration order.
func (p *ReferenceProcessor) droppedFile(e block.ContentEntry) (string, bool) {
	if !e.IsDataURI() || p.declaresImage(e) {
		return "", false
	}
	name, _ := e.Context["filename"].(string)
	// A filename is a label here, never a path: the stored asset is named after
	// the block.
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == string(filepath.Separator) {
		return "", false
	}
	return name, true
}

// declaresImage reads both statements an entry makes about its format — the OS's
// type and the data URI's own media type. An image dropped from a filesystem
// that has no type for it would otherwise arrive untyped and be claimed here.
func (p *ReferenceProcessor) declaresImage(e block.ContentEntry) bool {
	return strings.HasPrefix(e.MIMEType, "image/") ||
		strings.HasPrefix(strings.TrimSpace(e.Content), "data:image/")
}

// pastedCoordinate reports the canonical address a content entry carries, if
// any. Recognition is domain.ParseAddress, never a string-prefix test: a lenient
// match would mint a coordinate the resolver refuses forever.
//
// Whole-container Sieve coordinates only — an https link belongs to web-clip,
// and a pasted leaf address is left as the text it is.
func (p *ReferenceProcessor) pastedCoordinate(e block.ContentEntry) (string, bool) {
	addr, err := domain.ParseAddress(strings.TrimSpace(e.Content))
	if err != nil || !addr.IsContainer() {
		return "", false
	}
	return addr.String(), true
}

func (p *ReferenceProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		if uri, ok := p.pastedCoordinate(e); ok {
			// The parse's canonical spelling, not the pasted bytes, so no stray
			// whitespace is frozen into an attr that only fails at resolve time.
			return map[string]interface{}{"uri": uri}
		}
		if name, ok := p.droppedFile(e); ok {
			return p.holdDroppedFile(e, name, uuid, blockID)
		}
	}
	return nil
}

// holdDroppedFile stores a dropped file and returns the attrs the block is born
// with — the whole face, not a stub, since the bytes are in memory here.
//
// A failure returns nil, which means NO BLOCK: an addressless reference is born
// complete, so a half-made one would sit in the document as a blank chip nothing
// ever fills in.
func (p *ReferenceProcessor) holdDroppedFile(e block.ContentEntry, filename, uuid, blockID string) map[string]interface{} {
	data, err := e.DecodeDataURI()
	if err != nil {
		logger.Warn("reference: dropped file decode failed", "block", blockID, "file", filename, "err", err)
		return nil
	}
	if limit := p.maxHeldBytes(); len(data) > limit {
		logger.Warn("reference: dropped file over the size limit",
			"block", blockID, "file", filename, "bytes", len(data), "limit", limit)
		return nil
	}
	ref, err := p.assets.save(uuid, blockID+p.assetExt(filename), data)
	if err != nil {
		logger.Warn("reference: dropped file save failed", "block", blockID, "file", filename, "err", err)
		return nil
	}
	key := p.assets.filename(ref)
	if key == "" {
		logger.Warn("reference: saved asset has no key", "block", blockID, "file", filename, "ref", ref)
		return nil
	}
	mimeType := p.sniffMIME(key, data)
	// title is the file the user dropped; the address names the file on disk, and
	// the two are deliberately different (see assetExt).
	return map[string]interface{}{
		"uri":     domain.NewLeafAddress(uuid, key).String(),
		"title":   filename,
		"mime":    mimeType,
		"summary": p.excerpt(mimeType, data),
		// bytes is stored as a STRING: attrs round-trip through JSON on a paste,
		// which returns every number as a float64, and yaml.v3 writes a large
		// float64 in exponent form — so a numeric attr becomes "1e+08" on the
		// second save.
		"bytes": strconv.Itoa(len(data)),
	}
}

// assetExt is the extension the stored asset inherits from the dropped file. The
// asset itself is named after the BLOCK, never after the drop: a document
// directory holds content.md and meta.json beside its assets, so a file free to
// name itself could overwrite the document it was dropped into.
//
// Anything that is not a short alphanumeric suffix returns "", leaving the store
// to derive one from the bytes.
func (p *ReferenceProcessor) assetExt(filename string) string {
	ext := filepath.Ext(filename)
	if len(ext) < 2 || len(ext) > referenceMaxExtLen {
		return ""
	}
	for _, r := range ext[1:] {
		alnum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !alnum {
			return ""
		}
	}
	return strings.ToLower(ext)
}

func (p *ReferenceProcessor) OnChange(_ *block.SieveBlock) {}

// DescribeJob describes the one piece of work this kind has: dereferencing an
// address it has no face for. What the address names is not asked here — the
// Router federates that, so every target is one resolve.
func (p *ReferenceProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	if !p.resolvable(jctx.Block.Attrs) {
		return nil
	}
	return p.resolveJob(p.uri(jctx.Block.Attrs))
}

// referenceFace is the resolve job's result: what the coordinate names, or why
// nothing does.
type referenceFace struct {
	node domain.NodeDescriptor
	// dangling is non-empty when nothing answers for the address, and carries the
	// reason a chip shows: a target that went away, or a uri that was never a
	// coordinate.
	dangling string
}

// resolveJob dereferences a coordinate to the face the chip wears. It runs on
// the default pool: a resolve is a registry lookup, not AI work. Past the parse
// this kind does nothing with addresses — one Resolve, no scheme test, no
// fallback.
func (p *ReferenceProcessor) resolveJob(uri string) *block.ProcessorJob {
	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    "Resolving reference…",
		Work: func() (any, error) {
			addr, err := domain.ParseAddress(uri)
			if err != nil {
				// A malformed uri is not a broken job: no retry makes it parse, so
				// the block says so on its own face rather than sitting in ERROR.
				return referenceFace{dangling: uri + " is not a Sieve coordinate"}, nil
			}
			if p.svc.Nodes == nil {
				return nil, fmt.Errorf("reference: no resolver wired for %s", uri)
			}
			node, err := p.svc.Nodes.Resolve(addr)
			// Dangling is a normal state, not a job failure: the resolve completed
			// and found nothing. Any other failure may succeed on a retry, so it
			// stays a real error on the framework's ERROR path.
			if errors.Is(err, domain.ErrNodeNotFound) {
				return referenceFace{dangling: "nothing answers for " + uri + " any more"}, nil
			}
			if err != nil {
				return nil, err
			}
			return referenceFace{node: node}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			f := result.(referenceFace)
			if f.dangling != "" {
				// The cached face survives, so a reference whose target is gone
				// still says what it pointed at. COMPLETE plus a non-empty error is
				// the pair the chip's --missing modifier reads; ERROR keeps meaning
				// "the job broke".
				b.Attrs["error"] = f.dangling
			} else {
				if f.node.Title != "" {
					b.Attrs["title"] = f.node.Title
				}
				// A pointer's mime names Sieve's own space, not a media type: this
				// block points at a note, it does not hold one.
				b.Attrs["mime"] = "sieve/" + f.node.Kind
				b.Attrs["summary"] = f.node.Summary
				b.Attrs["error"] = ""
			}
			p.complete(b.Attrs)
		},
	}
}

// sniffMIME decides what a held file is. The table below is consulted BEFORE the
// stdlib's, because mime.TypeByExtension reads the host's /etc/mime.types — so
// the answer for .yml would differ between machines, and a stamped attr must
// not. Content sniffing is the last resort.
func (p *ReferenceProcessor) sniffMIME(filename string, data []byte) string {
	if m := p.mimeByExtension(filepath.Ext(filename)); m != "" {
		return m
	}
	if m := mime.TypeByExtension(filepath.Ext(filename)); m != "" {
		return p.bareMIME(m)
	}
	return p.bareMIME(http.DetectContentType(data))
}

// mimeByExtension is this kind's own extension table — only the formats a
// thinking tool actually holds. Anything not listed falls through to the stdlib.
func (p *ReferenceProcessor) mimeByExtension(ext string) string {
	switch strings.ToLower(ext) {
	case ".yml", ".yaml":
		return "text/yaml"
	case ".json":
		return "application/json"
	case ".md", ".markdown":
		return "text/markdown"
	case ".csv":
		return "text/csv"
	case ".tsv":
		return "text/tab-separated-values"
	case ".txt", ".log", ".ini", ".conf", ".cfg":
		return "text/plain"
	case ".xml":
		return "text/xml"
	case ".toml":
		return "text/toml"
	case ".html", ".htm":
		return "text/html"
	case ".css":
		return "text/css"
	case ".js", ".mjs":
		return "text/javascript"
	case ".sql":
		return "application/sql"
	case ".pdf":
		return "application/pdf"
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".zip":
		return "application/zip"
	}
	return ""
}

// bareMIME drops the parameters (charset, boundary) a sniffed type carries: the
// attr names a format, not an encoding.
func (p *ReferenceProcessor) bareMIME(m string) string {
	head, _, _ := strings.Cut(m, ";")
	return strings.TrimSpace(head)
}

// mimeFamily reduces a mime type to the short noun a chip wears: "yaml", "pdf",
// "note". sieve/note reduces by the same rule text/yaml does, so one `mime` attr
// serves both halves of the kind.
func (p *ReferenceProcessor) mimeFamily(mimeType string) string {
	_, sub, ok := strings.Cut(mimeType, "/")
	if !ok || sub == "" {
		return mimeType
	}
	if i := strings.Index(sub, "+"); i > 0 {
		sub = sub[:i] // image/svg+xml → svg
	}
	sub = strings.TrimPrefix(strings.TrimPrefix(sub, "vnd."), "x-")
	if sub == "plain" {
		return "text" // "text/plain" reads as "text"; nothing is called a "plain"
	}
	if i := strings.LastIndex(sub, "."); i >= 0 {
		sub = sub[i+1:] // the office types' last segment is the only readable part
	}
	return sub
}

// excerpt is the whole of a held file's summary: the first line that carries
// anything, clipped. No CLI call and no AI. Binary formats get nothing — text
// extraction from a PDF or docx is out of scope.
func (p *ReferenceProcessor) excerpt(mimeType string, data []byte) string {
	if !p.isPlainText(mimeType) {
		return ""
	}
	head := data
	if len(head) > referenceExcerptBytes {
		head = head[:referenceExcerptBytes]
	}
	for _, line := range strings.Split(string(head), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !utf8.ValidString(line) {
			return "" // the mime type lied; do not write mojibake into an attr
		}
		return p.clip(line, referenceSummaryChars)
	}
	return ""
}

// isPlainText reports whether these bytes are text this kind will excerpt. It
// reads the mime attr stamped at mint, never store.Encoding, which describes
// packaging (raw|base64|zipped) rather than content.
func (p *ReferenceProcessor) isPlainText(mimeType string) bool {
	if strings.HasPrefix(mimeType, "text/") {
		return true
	}
	switch mimeType {
	case "application/json", "application/xml", "application/javascript",
		"application/sql", "application/yaml", "application/x-yaml":
		return true
	}
	return false
}

// clip truncates on rune boundaries — a byte slice through a multi-byte
// character would put an invalid rune in a persisted attr.
func (p *ReferenceProcessor) clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n])) + "…"
}

// MaterialiseContent hands a held file's text over as ordinary content
// (block.ContentMaterialiser), so the kinds that recognise content can see what
// this block holds. What the text IS is theirs to say; this kind only decides
// whether the bytes are fit to hand over.
//
// The view is text/plain and NOT the stamped mime: that mime came from the
// dropped filename's extension, and offering it would let a file name decide
// what only its content can.
func (p *ReferenceProcessor) MaterialiseContent(uuid string, attrs map[string]interface{}) []block.ContentEntry {
	if !p.held(attrs) {
		return nil // a pointer holds no bytes of its own
	}
	mimeType, _ := attrs["mime"].(string)
	if !p.isPlainText(mimeType) {
		return nil
	}
	// The stamped size is consulted before the read, so an oversized file is never
	// loaded merely to be refused; the length is checked again after, because the
	// attr is only a claim about what is on disk.
	if n, known := p.storedBytes(attrs); !known || n > maxMaterialisedTextBytes {
		return nil
	}
	addr, ok := p.heldAddress(attrs)
	if !ok || p.svc.Assets == nil {
		return nil
	}
	data, err := p.svc.Assets.ServeAssetData(addr.Container, addr.Leaf)
	if err != nil {
		logger.Warn("reference: held file unreadable", "uuid", uuid, "uri", p.uri(attrs), "err", err)
		return nil
	}
	if len(data) > maxMaterialisedTextBytes || !utf8.Valid(data) {
		return nil // the mime type lied, or the file grew: hand over nothing
	}
	return []block.ContentEntry{{MIMEType: "text/plain", Content: string(data)}}
}

// storedBytes reads the byte count stamped at mint. It is a string attr (see
// holdDroppedFile), so an absent or unparseable one means "nothing is known
// about these bytes" rather than a file of length zero.
func (p *ReferenceProcessor) storedBytes(attrs map[string]interface{}) (int64, bool) {
	raw, _ := attrs["bytes"].(string)
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// BuildContext contributes the same three facts for both halves of the kind:
// what this is, where it lives, and what it says. It states facts and never
// instructs the model to fetch anything. A held file is named by its bare
// filename, which resolves because the CLI's cwd is the document directory.
func (p *ReferenceProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	uri := p.uri(blk.Attrs)
	if uri == "" {
		return block.AIContext{}
	}
	summary, _ := blk.Attrs["summary"].(string)
	// AIContext.String drops a tag whose values are all blank, so an unsummarised
	// or untyped reference needs no branch here.
	return block.AIContext{
		NodeIDs: []string{blk.ID},
		Content: "Reference: " + p.label(blk.Attrs, uri) + "\n",
		Tags: []block.Tag{
			{Label: "Address", Values: []string{uri}},
			{Label: "Type", Values: []string{p.typeLine(blk.Attrs)}},
			{Label: "Summary", Values: []string{summary}},
		},
	}
}

// label is what a reference is called: its cached title, else the file it holds,
// else the coordinate itself. It is never empty.
func (p *ReferenceProcessor) label(attrs map[string]interface{}, uri string) string {
	if title, _ := attrs["title"].(string); strings.TrimSpace(title) != "" {
		return strings.TrimSpace(title)
	}
	if p.held(attrs) {
		if addr, ok := p.heldAddress(attrs); ok {
			return addr.Leaf
		}
	}
	return uri
}

// typeLine is a reference's one-line description of itself: "yaml · 412 KB" for
// a held file, "note" for a pointer. Either half may be missing, and the line
// shortens rather than inventing a placeholder.
func (p *ReferenceProcessor) typeLine(attrs map[string]interface{}) string {
	var parts []string
	if mimeType, _ := attrs["mime"].(string); strings.TrimSpace(mimeType) != "" {
		parts = append(parts, p.mimeFamily(strings.TrimSpace(mimeType)))
	}
	if size := p.humanSize(attrs); size != "" {
		parts = append(parts, size)
	}
	return strings.Join(parts, " · ")
}

// humanSize renders the stored byte count for a reader. An unstamped size
// renders nothing.
func (p *ReferenceProcessor) humanSize(attrs map[string]interface{}) string {
	n, known := p.storedBytes(attrs)
	if !known {
		return ""
	}
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	suffixes := [...]string{"KB", "MB", "GB", "TB"}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < len(suffixes)-1; m /= unit {
		div *= unit
		exp++
	}
	v := float64(n) / float64(div)
	if v < 10 {
		return strconv.FormatFloat(v, 'f', 1, 64) + " " + suffixes[exp]
	}
	return strconv.FormatFloat(v, 'f', 0, 64) + " " + suffixes[exp]
}

// MarkdownRepresentation renders the block as a link. Export markdown is read
// outside Sieve, so a held file points at its served asset URL; a pointer
// carries its coordinate verbatim, because no URL exists for a Sieve address.
func (p *ReferenceProcessor) MarkdownRepresentation(blk block.SieveBlock, uuid string) string {
	uri := p.uri(blk.Attrs)
	if uri == "" {
		return ""
	}
	href := uri
	if p.held(blk.Attrs) {
		addr, ok := p.heldAddress(blk.Attrs)
		if !ok {
			return ""
		}
		href = p.assets.url(addr.Container, addr.Leaf)
	}
	return "[" + p.label(blk.Attrs, uri) + "](" + href + ")"
}
