package processors

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// errEntryNotImage marks a content entry this processor does not ingest, so the
// Transform loop moves on to the next entry. Any OTHER error means the entry WAS
// claimed and its ingest failed — that aborts the whole transform.
var errEntryNotImage = errors.New("entry is not an image this processor ingests")

// SmartImageProcessor handles the 'smart-image' Kind.
// PasteMatch saves the image file synchronously so the block is created with
// src already set. RunJob is AI-only: it calls DescribeImage on the saved file.
type SmartImageProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewSmartImageProcessor(svc block.BlockServices) *SmartImageProcessor {
	return &SmartImageProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "smart-image"}}
}

func (p *SmartImageProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *SmartImageProcessor) Mode() block.BlockMode { return block.BlockModeBlock }
func (p *SmartImageProcessor) IDPrefix() string      { return "img" }

func (p *SmartImageProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":      id,
		"src":     "",
		"alt":     "",
		"summary": "",
		"detect":  "",
		"width":   "",
		"height":  "",
		// showSummary is a persisted RENDERING attribute (same family as a block's
		// mode), not derived data: some images earn their AI description a place
		// under them and most do not, so the choice is per-block and remembered.
		// Default off — an auto-generated line is never shown unasked (#73).
		"showSummary":       false,
		"status":            block.BlockStatusComplete,
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	// If PasteMatch set a src, we need AI to describe it.
	if src, _ := attrs["src"].(string); src != "" {
		attrs["status"] = block.BlockStatusPending
		attrs["createdAt"] = time.Now().UTC().Format(time.RFC3339)
	}
	return attrs
}

func (p *SmartImageProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	native := []block.Action{block.ActionPaste, block.ActionTransform}
	sieve := []block.Action{block.ActionPaste, block.ActionExtract}
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if e.MIMEType == "image/svg+xml" {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: sieve}
		}
		if isImageURL(strings.TrimSpace(e.Content)) {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if block.MermaidFenceRe.MatchString(e.Content) {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: sieve}
				}
			}
			// plantuml has no client-side renderer: the frontend's acquisition path
			// (renderDiagramSvgEntry) fetches the already-persisted svgAsset, so
			// offering extract before a render job has produced one would be a lie.
			if dt, _ := attrs["diagramType"].(string); dt == "plantuml" {
				if svg, _ := attrs["svgAsset"].(string); strings.TrimSpace(svg) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: sieve}
				}
			}
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				return block.SupportedActions{Kind: p.Kind(), Actions: native}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// Transform is ONE shape for every ingest path — clipboard paste (raster or SVG
// data URI), locally-rendered SVG (the diagram→image convert), URL download, HTML
// <img>, and an already-stored sieve asset. Each path only ACQUIRES the image;
// persistence and, crucially, sizing happen in a SINGLE place afterwards. Before
// #53 every branch hand-built its own attr map and only the raw-SVG one carried a
// dimension, so paste and convert landed unsized (an SVG has no intrinsic pixel
// size, so unsized means zero — a bare resize handle).
func (p *SmartImageProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		data, ref, err := p.acquire(e, blockID)
		if errors.Is(err, errEntryNotImage) {
			continue
		}
		if err != nil {
			logger.Warn("smart-image: transform failed", "block", blockID, "err", err)
			return nil
		}

		// A pre-stored asset is a pure REFERENCE: there are no bytes to persist and
		// none to measure, so it is the one path that stamps no size (the renderer
		// lays an unsized image out responsively).
		src, width, height := ref, 0, 0
		if src == "" {
			var ok bool
			if width, height, ok = p.measure(data); !ok {
				logger.Warn("smart-image: entry is not a usable image", "block", blockID, "bytes", len(data))
				return nil
			}
			if src, err = p.saveAsset(uuid, blockID, data); err != nil {
				logger.Warn("smart-image: transform save failed", "block", blockID, "err", err)
				return nil
			}
		}

		attrs := map[string]interface{}{"src": src}
		if width > 0 {
			attrs["width"] = strconv.Itoa(width)
		}
		if height > 0 {
			attrs["height"] = strconv.Itoa(height)
		}
		return attrs
	}
	return nil
}

// acquire resolves ONE content entry to the image it denotes. Exactly one result is
// meaningful: `data` is freshly ingested bytes the caller must persist, `ref` is an
// asset already stored under this document. errEntryNotImage means the entry is not
// this processor's to take (try the next one); any other error aborts the transform.
func (p *SmartImageProcessor) acquire(e block.ContentEntry, blockID string) (data []byte, ref string, err error) {
	// Data URI (paste from clipboard) — raster OR svg; naturalSize sniffs which.
	if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
		raw, err := p.decodeDataURI(e.Content)
		if err != nil {
			return nil, "", fmt.Errorf("data URI decode: %w", err)
		}
		return raw, "", nil
	}
	// Raw SVG rendered locally by the JS frontend via resolveEntries
	if e.MIMEType == "image/svg+xml" {
		return []byte(e.Content), "", nil
	}
	// Image URL (paste or extract from HTML)
	s := strings.TrimSpace(e.Content)
	if isImageURL(s) {
		// Already a local sieve asset: reference the filename, ingest nothing.
		if strings.Contains(s, "/sieve/") {
			filename := s[strings.LastIndex(s, "/")+1:]
			if idx := strings.Index(filename, "?"); idx != -1 {
				filename = filename[:idx]
			}
			return nil, filename, nil
		}
		raw, err := p.downloadImage(s, blockID)
		if err != nil {
			return nil, "", fmt.Errorf("download %s: %w", s, err)
		}
		return raw, "", nil
	}
	if e.MIMEType == "text/html" {
		if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
			raw, err := p.downloadImage(src, blockID)
			if err != nil {
				return nil, "", fmt.Errorf("download html <img> %s: %w", src, err)
			}
			return raw, "", nil
		}
	}
	// Mermaid source arriving without JS pre-processing — cannot render server-side.
	// resolveEntries in SmartImageRenderer must convert mermaid to SVG before this is called.
	if block.MermaidFenceRe.MatchString(e.Content) {
		return nil, "", errors.New("mermaid source reached Transform unresolved; resolveEntries must render SVG locally")
	}
	return nil, "", errEntryNotImage
}

// measure is THE sizing rule, and it reports the image's OWN dimensions — never a
// layout decision. Raster reads the decoded config bounds; SVG reads the root
// element's absolute width/height, else its viewBox extent (mermaid emits one).
// `ok` reports whether the bytes are an image this processor can store at all — the
// only validity check ingest needs.
//
// A recognised image whose size is genuinely undeclarable (an SVG with neither a
// size nor a viewBox) measures (0, 0, true): stored unsized, DELIBERATELY. No
// default is invented here, because a stored number is frozen into the document
// while the renderer's unsized case fills the available width and re-adapts on every
// resize. #53 was caused by inventing sizes per-branch; the fix is to stop.
func (p *SmartImageProcessor) measure(data []byte) (width, height int, ok bool) {
	if p.looksLikeSVG(data) {
		w, h := p.svgDeclaredSize(data)
		if w <= 0 || h <= 0 {
			return 0, 0, true
		}
		return int(math.Round(w)), int(math.Round(h)), true
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

// looksLikeSVG recognises an SVG document, optionally behind an XML prolog or a
// doctype. image.DecodeConfig only knows raster formats, so SVG has to be spotted
// by its markup.
func (p *SmartImageProcessor) looksLikeSVG(data []byte) bool {
	head := bytes.TrimSpace(data)
	if len(head) > 1024 {
		head = head[:1024]
	}
	if bytes.HasPrefix(head, []byte("<svg")) {
		return true
	}
	return (bytes.HasPrefix(head, []byte("<?xml")) || bytes.HasPrefix(head, []byte("<!"))) &&
		bytes.Contains(head, []byte("<svg"))
}

// svgDeclaredSize reads the size an SVG document declares on its root element:
// absolute width/height attributes when BOTH are present and unitless/px, else the
// viewBox extent. (0, 0) when it declares neither, or when the markup will not parse
// far enough to tell.
func (p *SmartImageProcessor) svgDeclaredSize(data []byte) (width, height float64) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	var root xml.StartElement
	for {
		tok, err := dec.Token()
		if err != nil {
			return 0, 0
		}
		if se, ok := tok.(xml.StartElement); ok {
			root = se
			break
		}
	}
	if root.Name.Local != "svg" {
		return 0, 0
	}

	var viewBox string
	for _, a := range root.Attr {
		switch a.Name.Local {
		case "width":
			width = p.parseCSSLength(a.Value)
		case "height":
			height = p.parseCSSLength(a.Value)
		case "viewBox":
			viewBox = a.Value
		}
	}
	if width > 0 && height > 0 {
		return width, height
	}
	// viewBox is "min-x min-y width height" — its extent IS the natural size when
	// the root declares no absolute one (mermaid emits exactly this shape).
	fields := strings.FieldsFunc(viewBox, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r' })
	if len(fields) != 4 {
		return 0, 0
	}
	w, errW := strconv.ParseFloat(fields[2], 64)
	h, errH := strconv.ParseFloat(fields[3], 64)
	if errW != nil || errH != nil || w <= 0 || h <= 0 {
		return 0, 0
	}
	return w, h
}

// parseCSSLength reads an SVG length that maps directly to CSS pixels — a bare
// number or a px value. Anything relative (%, em, …) is NOT a pixel size, so it
// yields 0 and the caller falls through to the viewBox.
func (p *SmartImageProcessor) parseCSSLength(s string) float64 {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "px"))
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 {
		return 0
	}
	return v
}

func (p *SmartImageProcessor) OnChange(_ *block.SieveBlock) {}

func (p *SmartImageProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	src, _ := blk.Attrs["src"].(string)
	alt, _ := blk.Attrs["alt"].(string)
	summary, _ := blk.Attrs["summary"].(string)
	if src == "" {
		return block.AIContext{}
	}
	filename := filepath.Base(src)
	var sb strings.Builder
	sb.WriteString("Image: " + filename + "\n")
	ctx := block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
	ctx.Tags = []block.Tag{
		{Label: "ALT", Values: []string{alt}},
		{Label: "Summary", Values: []string{summary}},
	}
	return ctx
}

// DescribeJob is AI-only, or nil when there is no src to describe. The predicate
// mirrors InitAttrs (PENDING iff src != ""): an src-less image is born COMPLETE and
// never dispatched. The image file is already saved; Work calls DescribeImage and
// Apply writes the description attrs. The error path (status ERROR/TIMEOUT) is the
// framework's job, so Apply is success-only.
func (p *SmartImageProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	uuid, blk := jctx.UUID, jctx.Block
	src, _ := blk.Attrs["src"].(string)
	id := blk.ID
	if src == "" {
		return nil // no src: no describe job (created COMPLETE)
	}
	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Describing image…",
		Work: func() (any, error) {
			logger.Info("smart-image: calling DescribeImage", "block", id, "src", src)
			desc, err := p.svc.AI.DescribeImage(uuid, src, id)
			if err != nil {
				logger.Warn("smart-image: DescribeImage failed", "block", id, "err", err)
				return nil, err
			}
			logger.Info("smart-image: DescribeImage complete", "block", id, "summary_len", len(desc.Summary))
			return desc, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			desc := result.(domain.ImageDesc)
			b.Attrs["summary"] = desc.Summary
			b.Attrs["alt"] = desc.Alt
			b.Attrs["detect"] = desc.Detect
			b.Attrs["status"] = block.BlockStatusComplete
		},
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func isImageURL(s string) bool {
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "/") && !strings.Contains(s, "/sieve/") {
		return false
	}
	if strings.ContainsAny(s, " \t\n\r") {
		return false
	}

	path := s
	if idx := strings.Index(path, "?"); idx != -1 {
		path = path[:idx]
	}
	if idx := strings.Index(path, "#"); idx != -1 {
		path = path[:idx]
	}

	lower := strings.ToLower(path)
	return strings.HasSuffix(lower, ".png") || strings.HasSuffix(lower, ".jpg") ||
		strings.HasSuffix(lower, ".jpeg") || strings.HasSuffix(lower, ".gif") ||
		strings.HasSuffix(lower, ".webp") || strings.HasSuffix(lower, ".svg")
}

func extractHTMLImageSrc(html string) string {
	if !strings.Contains(html, "<img ") && !strings.Contains(html, "<img\n") {
		return ""
	}
	idx := strings.Index(html, `src="`)
	if idx == -1 {
		return ""
	}
	rest := html[idx+5:]
	end := strings.Index(rest, `"`)
	if end == -1 {
		return ""
	}
	return rest[:end]
}

// decodeDataURI reads the bytes carried by a `data:` URI. The metadata half declares
// the payload encoding, so both shapes a clipboard produces are honoured: `;base64`
// (raster paste, and most SVG sources) and a percent-encoded text payload (the shape
// an SVG data URI takes when it is not base64'd). It ACQUIRES only — the bytes are
// validated by naturalSize and stored by saveAsset, both in Transform.
func (p *SmartImageProcessor) decodeDataURI(dataURI string) ([]byte, error) {
	meta, payload, ok := strings.Cut(dataURI, ",")
	if !ok {
		return nil, errors.New("invalid data URI: no comma separator")
	}

	if !strings.Contains(meta, ";base64") {
		text, err := url.PathUnescape(payload)
		if err != nil {
			return nil, fmt.Errorf("percent-decode: %w", err)
		}
		return []byte(text), nil
	}

	// Clipboard sources wrap the payload; whitespace is not part of the alphabet.
	b64 := strings.NewReplacer("\n", "", "\r", "", "\t", "", " ", "").Replace(payload)
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err == nil {
		return raw, nil
	}
	if urlAlphabet, urlErr := base64.URLEncoding.DecodeString(b64); urlErr == nil {
		return urlAlphabet, nil
	}
	return nil, fmt.Errorf("base64 decode (%d chars): %w", len(b64), err)
}

// downloadImage fetches the bytes at imageURL. Like every other acquisition path it
// only ACQUIRES: it does not decide validity (naturalSize does) and does not persist
// (saveAsset does), so a downloaded image is measured and stored by exactly the same
// rule as a pasted one. The timeout and size limit mirror SmartCardProcessor's fetch.
func (p *SmartImageProcessor) downloadImage(imageURL, blockID string) ([]byte, error) {
	logger.Info("smart-image: downloading", "block", blockID, "url", imageURL)
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(imageURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed, status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
}

func (p *SmartImageProcessor) saveAsset(uuid, blockID string, data []byte) (string, error) {
	cat := domain.WorkingCopy
	var doc domain.Document
	if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		doc = d
		if doc.Kind() == domain.KindNote {
			cat = domain.LibraryCategory
		}
	}

	logger.Info("smart-image: saving asset", "block", blockID, "uuid", uuid, "bytes", len(data))
	asset, err := p.svc.Assets.Save(cat, uuid, blockID, data)
	if err != nil {
		return "", err
	}

	if doc != nil {
		doc.Storable().AttachAsset(asset.Storable())
		if _, err := p.svc.Documents.Save(doc); err != nil {
			// Non-fatal: asset is saved; attachment metadata will be missing
			logger.Warn("smart-image: doc save after attach failed", "block", blockID, "err", err)
		}
	}

	return asset.ExternalRef(), nil
}

func (p *SmartImageProcessor) MarkdownRepresentation(blk block.SieveBlock, uuid string) string {
	src, _ := blk.Attrs["src"].(string)
	if src == "" {
		return ""
	}
	alt, _ := blk.Attrs["alt"].(string)
	if strings.TrimSpace(alt) == "" {
		alt, _ = blk.Attrs["summary"].(string)
	}
	return "![" + strings.TrimSpace(alt) + "](" + p.assetURL(uuid, src) + ")"
}

// assetURL builds the served URL the document renders: /sieve/<uuid>/<filename>. A
// stored smart-image src is always a local asset filename (Transform downloads/renders
// everything to disk), so this only needs to prefix it with the asset route — the
// markdown must carry a working URL, since prose-embedded images render as a plain
// <img> (the NodeView's resolveSrc never runs on them). The .assets/ strip + basename
// are defensive against an older/path-qualified src.
func (p *SmartImageProcessor) assetURL(uuid, src string) string {
	if src == "" {
		return ""
	}
	src = strings.TrimPrefix(src, ".assets/")
	if i := strings.LastIndex(src, "/"); i >= 0 {
		src = src[i+1:]
	}
	return "/sieve/" + uuid + "/" + src
}
