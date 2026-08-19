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

	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// attachmentSummaryChars caps a held file's excerpt. A summary is ONE LINE under
// a chip's title, not a preview pane — reading the file is the chevron's job.
const attachmentSummaryChars = 200

// attachmentExcerptBytes bounds how far into an asset the excerpt looks. The
// bytes are already in memory, but a 100MB log must not be split line-by-line to
// find its first non-blank one. A file whose FIRST line is longer than this (a
// minified JSON, say) gets no excerpt rather than a mid-rune slice — an honest
// blank, and the chip still names the file and states its size.
const attachmentExcerptBytes = 4096

// AttachmentProcessor handles the 'attachment' Kind — a chip that either HOLDS a
// file the document is about, or POINTS at another Sieve container.
//
// It is built from the two kinds that already do each half of the job:
// smart-card is the LIFECYCLE parent (an address is resolved to a cached face by
// a job, and the face refreshes on resolve), smart-image is the ASSET parent (the
// block names a file in the document directory; AssetService owns the bytes).
//
// Exactly one of src/uri is ever set, and that is the kind's ONLY discriminator.
// It forks in exactly one method — DescribeJob, choosing which resolver
// populates the face. Every other method is uniform across both halves, because
// a held asset and a cited document both contribute A NAME AND A LOCATION, which
// is why this is one kind rather than two.
//
// What it deliberately does NOT do: mint an address space of its own (the block
// IS the addressable thing, exactly as smart-image is — reached as
// block:{container}/{blockID} by the ordinary grammar), and reach for the
// composer's attachment-manifest machinery (that exists to compensate for a
// textarea having nowhere to put a block; this is a block in a container).
type AttachmentProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewAttachmentProcessor(svc block.BlockServices) *AttachmentProcessor {
	return &AttachmentProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "attachment"}}
}

func (p *AttachmentProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *AttachmentProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *AttachmentProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":         id,
		"src":        "", // holds: an asset filename in the document directory
		"uri":        "", // points: a container:{uuid} coordinate
		"title":      "",
		"targetKind": "", // "note" for a citation; the mime family for a file
		"summary":    "",
		// bytes/mime are stamped from the asset itself, so a held file's chip can
		// read "yaml · 412 KB" without anyone having opened it.
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
	// Complete-vs-pending predicate MUST mirror DescribeJob: no address ⇒ nothing
	// to resolve or read ⇒ born COMPLETE (never dispatched). Both parents carry
	// this guard for their own empty-address case and this kind inherits it
	// verbatim — get the two out of step and the block hangs PENDING forever.
	//
	// It is decided AFTER the overrides and it OVERRULES them, so the predicate is
	// exact in both directions. A copied attachment pastes its whole cached face,
	// status included, and a COMPLETE block with an address would describe a job
	// nothing ever dispatches. Re-arming it is also the right answer on its own
	// terms: a block is a LIVE reference, so a pasted one resolves afresh rather
	// than inheriting whatever the original last saw.
	src, uri := p.address(attrs)
	if src == "" && uri == "" {
		attrs["status"] = block.BlockStatusComplete
	} else {
		attrs["status"] = block.BlockStatusPending
	}
	return attrs
}

// address reads the block's ONE address attr. Exactly one of src/uri is ever set
// — the kind's only invariant — so this is the single place the pair is read and
// the single place the (illegal) both-set case is broken: uri wins, arbitrarily
// but FIXEDLY. Deciding it once keeps DescribeJob, BuildContext and
// MarkdownRepresentation forking identically; three independent reads of the same
// pair would eventually disagree about what such a block is.
func (p *AttachmentProcessor) address(attrs map[string]interface{}) (src, uri string) {
	src, _ = attrs["src"].(string)
	uri, _ = attrs["uri"].(string)
	src, uri = strings.TrimSpace(src), strings.TrimSpace(uri)
	if uri != "" {
		return "", uri
	}
	return src, ""
}

// IsSupportedContent claims a copied attachment (round-trip: paste + extract) and
// a pasted Sieve coordinate as a TRANSFORM, mirroring how web-clip claims a
// pasted link. A file never arrives through this path — a drop is #68's non-image
// case, which creates the block with src already set.
func (p *AttachmentProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if _, ok := p.pastedCoordinate(e); ok {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// pastedCoordinate reports the CANONICAL address a content entry carries, if any.
// Recognition is domain.ParseAddress and never a string-prefix test: the grammar
// has exactly one reader, and a lenient match here would mint a coordinate the
// resolver refuses forever — a dangling chip the user never asked for.
//
// Only the container scheme is claimed. block: is legal grammar, but Router.Resolve
// answers for containers alone, so a pasted block: address has nothing to resolve
// against and is left as the text it is.
func (p *AttachmentProcessor) pastedCoordinate(e block.ContentEntry) (string, bool) {
	addr, err := domain.ParseAddress(strings.TrimSpace(e.Content))
	if err != nil || addr.Scheme != domain.SchemeContainer {
		return "", false
	}
	return addr.String(), true
}

func (p *AttachmentProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		if uri, ok := p.pastedCoordinate(e); ok {
			// The parse's canonical spelling, not the pasted bytes: a trailing
			// newline or an odd version pin would otherwise be frozen into an attr
			// that only fails later, at resolve time.
			return map[string]interface{}{"uri": uri}
		}
	}
	return nil
}

func (p *AttachmentProcessor) OnChange(_ *block.SieveBlock) {}

// DescribeJob is THE one method that forks, and the fork is the kind's whole
// discriminator: a uri is dereferenced through the Router, a src is read off
// disk. No address means no job — the block was born COMPLETE by InitAttrs and is
// never dispatched.
func (p *AttachmentProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	src, uri := p.address(jctx.Block.Attrs)
	switch {
	case uri != "":
		return p.resolveJob(uri)
	case src != "":
		return p.ingestJob(jctx.UUID, src)
	default:
		return nil // no address: nothing to resolve or read (created COMPLETE)
	}
}

// attachmentFace is the resolve job's result: what the coordinate names, and
// whether it names anything at all.
type attachmentFace struct {
	node    domain.Node
	missing bool
}

// resolveJob dereferences a coordinate to the face the chip wears. It runs on the
// DEFAULT pool: a resolve is a local registry lookup, not AI work.
//
// Unlike a composer chip — whose title is deliberately FROZEN at attach time,
// because a turn is a historical record — a block is a LIVE reference and its
// face refreshes on every resolve. That is smart-card's behaviour, and copying
// the composer's here would be wrong.
func (p *AttachmentProcessor) resolveJob(uri string) *block.ProcessorJob {
	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    "Resolving reference…",
		Work: func() (any, error) {
			if p.svc.Nodes == nil {
				return nil, fmt.Errorf("attachment: no resolver wired for %s", uri)
			}
			node, err := p.svc.Nodes.Resolve(uri)
			// DANGLING is a NORMAL state, not a job failure — domain.ErrNodeNotFound
			// says so in its own doc: the resolve COMPLETED, and what it found was
			// nothing. Every OTHER refusal (a malformed address, an unsupported
			// scheme) will never succeed on a retry either, so it is a real error and
			// the framework's ERROR path is what reports it.
			if errors.Is(err, domain.ErrNodeNotFound) {
				return attachmentFace{missing: true}, nil
			}
			if err != nil {
				return nil, err
			}
			return attachmentFace{node: node}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			f := result.(attachmentFace)
			if f.missing {
				// The cached face SURVIVES: a reference whose target is gone still
				// says what it pointed at. COMPLETE + a non-empty error is the pair
				// the chip's --missing modifier reads, which keeps ERROR meaning
				// "the job broke" — what the framework's own error path sets.
				b.Attrs["error"] = "nothing answers for " + uri + " any more"
			} else {
				if f.node.Title != "" {
					b.Attrs["title"] = f.node.Title
				}
				b.Attrs["targetKind"] = f.node.Kind
				b.Attrs["summary"] = f.node.Summary
				b.Attrs["error"] = ""
			}
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
		},
	}
}

// heldAsset is the ingest job's result: everything the bytes themselves say.
type heldAsset struct {
	filename string
	mime     string
	kind     string
	bytes    int
	summary  string
}

// ingestJob reads a held file and stamps what it is. It is smart-image's describe
// job WITHOUT the CLI call — deliberately: an attachment states what it is and
// where it lives, and interpreting the contents is the model's job on the ask
// that actually needs them. So this runs on the DEFAULT pool and never queues
// behind AI work.
func (p *AttachmentProcessor) ingestJob(uuid, src string) *block.ProcessorJob {
	filename := p.filename(src)
	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    "Reading " + filename,
		Work: func() (any, error) {
			if p.svc.Assets == nil {
				return nil, fmt.Errorf("attachment: no asset service wired for %s", filename)
			}
			// Unlike a dangling coordinate, missing bytes ARE a failure: the drop
			// path saves the asset before the block exists, so an unreadable one
			// means something went wrong rather than something went away.
			data, err := p.svc.Assets.ServeAssetData(uuid, filename)
			if err != nil {
				return nil, fmt.Errorf("attachment: read %s: %w", filename, err)
			}
			mimeType := p.sniffMIME(filename, data)
			return heldAsset{
				filename: filename,
				mime:     mimeType,
				kind:     p.mimeFamily(mimeType),
				bytes:    len(data),
				summary:  p.excerpt(mimeType, data),
			}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			a := result.(heldAsset)
			if t, _ := b.Attrs["title"].(string); strings.TrimSpace(t) == "" {
				b.Attrs["title"] = a.filename // a chip always has a label
			}
			b.Attrs["mime"] = a.mime
			b.Attrs["targetKind"] = a.kind
			// bytes is stored as a STRING, like smart-image's width/height. Attrs
			// round-trip through JSON on a copy/paste, which returns every number as
			// a float64, and yaml.v3 writes a large float64 in exponent form — so a
			// numeric attr silently becomes "1e+08" on the second save.
			b.Attrs["bytes"] = strconv.Itoa(a.bytes)
			b.Attrs["summary"] = a.summary
			b.Attrs["error"] = ""
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
		},
	}
}

// filename recovers the bare asset name from a stored src. A src is always a
// filename in the document directory; the .assets/ strip and the basename are
// defensive against a path-qualified one, mirroring smart-image's assetURL.
func (p *AttachmentProcessor) filename(src string) string {
	return filepath.Base(strings.TrimPrefix(strings.TrimSpace(src), ".assets/"))
}

// sniffMIME decides what a held file IS. The extension table below is consulted
// BEFORE the stdlib's, because mime.TypeByExtension reads the host's
// /etc/mime.types on unix — so the answer for .yml differs between a developer's
// machine and CI, and a stamped attr must not. Content sniffing is the last
// resort, for a file with no extension at all.
func (p *AttachmentProcessor) sniffMIME(filename string, data []byte) string {
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
func (p *AttachmentProcessor) mimeByExtension(ext string) string {
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

// bareMIME drops the parameters (charset, boundary) a sniffed type carries. The
// attr names a FORMAT; the encoding of the bytes is not part of it.
func (p *AttachmentProcessor) bareMIME(m string) string {
	head, _, _ := strings.Cut(m, ";")
	return strings.TrimSpace(head)
}

// mimeFamily reduces a mime type to the SHORT NOUN a chip wears: "yaml", "pdf",
// "text". It fills the same attr a citation fills with "note", so the two halves
// of the kind read as one vocabulary rather than as two.
func (p *AttachmentProcessor) mimeFamily(mimeType string) string {
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

// excerpt is the whole of a held file's summary, and it is DELIBERATELY dumb: the
// first line that carries anything, clipped. No CLI call and no AI — the block
// states facts, and a model that wants the contents reads the file itself (the
// CLI's cwd is the document directory).
//
// Binary formats get nothing. Extracting text from a PDF or a docx is a
// dependency conversation and explicitly out of scope; decoded rubbish under a
// chip would be worse than an honest blank, and the chip still names the file and
// states its size.
func (p *AttachmentProcessor) excerpt(mimeType string, data []byte) string {
	if !p.isPlainText(mimeType) {
		return ""
	}
	head := data
	if len(head) > attachmentExcerptBytes {
		head = head[:attachmentExcerptBytes]
	}
	for _, line := range strings.Split(string(head), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !utf8.ValidString(line) {
			return "" // the mime type lied; do not write mojibake into an attr
		}
		return p.clip(line, attachmentSummaryChars)
	}
	return ""
}

// isPlainText reports whether these bytes are text this kind will excerpt. The
// distinction comes from the MIME attr stamped at ingest and NEVER from
// store.Encoding, which describes PACKAGING (raw|base64|zipped), not content.
func (p *AttachmentProcessor) isPlainText(mimeType string) bool {
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

// clip truncates on RUNE boundaries — a byte slice through a multi-byte character
// would put an invalid rune in a persisted attr.
func (p *AttachmentProcessor) clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n])) + "…"
}

// BuildContext contributes the same two facts for both halves of the kind — WHAT
// this is and WHERE it lives — which is precisely why holding and pointing are
// one block rather than two. Nothing on the prompt path branches on it, and the
// block is never assembled into a manifest: it contributes like every other
// block, when the ask's context contains it.
func (p *AttachmentProcessor) BuildContext(blk block.SieveBlock, doc block.DocView, _ map[string]bool) block.AIContext {
	src, uri := p.address(blk.Attrs)
	if src == "" && uri == "" {
		return block.AIContext{}
	}
	summary, _ := blk.Attrs["summary"].(string)

	var sb strings.Builder
	var tags []block.Tag
	if uri != "" {
		// A citation names the thing and states the coordinate it points at. It does
		// NOT instruct the model to call get_by_uri — smart-card does not tell it to
		// fetch its href either. The MCP verb is standing capability; the block
		// states facts.
		sb.WriteString("Attachment: " + p.citationLabel(blk.Attrs, uri) + "\n")
		tags = append(tags, block.Tag{Label: "Address", Values: []string{uri}})
	} else {
		// A held file is named by its BARE FILENAME because the CLI's cwd IS the
		// document directory, so a relative path resolves — exactly how
		// AIService.DescribeImage already reaches an image. No MCP verb, no address
		// scheme of its own, no containment change.
		sb.WriteString("Attachment: " + p.filename(src) + "\n")
		// Its address is the BLOCK'S OWN: the block is the addressable thing, as
		// smart-image is, so a held asset is reached by the ordinary block grammar.
		// Built through domain.Address rather than concatenated, so no scheme is
		// spelled here.
		if doc.UUID != "" {
			own := domain.Address{Scheme: domain.SchemeBlock, Container: doc.UUID, Block: blk.ID}
			tags = append(tags, block.Tag{Label: "Address", Values: []string{own.String()}})
		}
		tags = append(tags, block.Tag{Label: "Type", Values: []string{p.typeLine(blk.Attrs)}})
	}
	// Appended unconditionally: AIContext.String drops a tag whose values are all
	// blank, so an unsummarised attachment needs no branch here.
	tags = append(tags, block.Tag{Label: "Summary", Values: []string{summary}})
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String(), Tags: tags}
}

// citationLabel is what a pointing attachment is CALLED: its cached title,
// qualified by the target's own noun ("Auth Design (note)"). An unresolved or
// dangling reference falls back to the coordinate, which is still true.
func (p *AttachmentProcessor) citationLabel(attrs map[string]interface{}, uri string) string {
	label, _ := attrs["title"].(string)
	if label = strings.TrimSpace(label); label == "" {
		label = uri
	}
	if kind, _ := attrs["targetKind"].(string); strings.TrimSpace(kind) != "" {
		label += " (" + strings.TrimSpace(kind) + ")"
	}
	return label
}

// typeLine is a held file's one-line description of itself: "yaml · 412 KB".
// Either half may be missing (a file read that has not landed yet), and the line
// simply shortens rather than inventing a placeholder.
func (p *AttachmentProcessor) typeLine(attrs map[string]interface{}) string {
	var parts []string
	if kind, _ := attrs["targetKind"].(string); strings.TrimSpace(kind) != "" {
		parts = append(parts, strings.TrimSpace(kind))
	}
	if size := p.humanSize(attrs); size != "" {
		parts = append(parts, size)
	}
	return strings.Join(parts, " · ")
}

// humanSize renders the stored byte count for a reader. bytes is a string attr
// (see the ingest job's Apply for why), so a value that will not parse renders
// nothing rather than a lie.
func (p *AttachmentProcessor) humanSize(attrs map[string]interface{}) string {
	raw, _ := attrs["bytes"].(string)
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || n < 0 {
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

// MarkdownRepresentation renders the block as the one thing both halves are: a
// LINK. Export markdown is read outside Sieve, so a held file points at its
// served asset URL (mirroring smart-image); a citation carries the coordinate
// verbatim, because there is no URL for a Sieve address and inventing one would
// be a lie the reader cannot detect.
func (p *AttachmentProcessor) MarkdownRepresentation(blk block.SieveBlock, uuid string) string {
	src, uri := p.address(blk.Attrs)
	title, _ := blk.Attrs["title"].(string)
	title = strings.TrimSpace(title)
	switch {
	case uri != "":
		if title == "" {
			title = uri
		}
		return "[" + title + "](" + uri + ")"
	case src != "":
		name := p.filename(src)
		if title == "" {
			title = name
		}
		return "[" + title + "](/sieve/" + uuid + "/" + name + ")"
	}
	return ""
}
