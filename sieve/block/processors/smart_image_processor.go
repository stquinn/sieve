package processors

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

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
		"id":                id,
		"src":               "",
		"alt":               "",
		"summary":           "",
		"detect":            "",
		"width":             "",
		"height":            "",
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
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				return block.SupportedActions{Kind: p.Kind(), Actions: native}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *SmartImageProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		// Base64 data URI (paste from clipboard)
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			filename, err := p.saveBase64(uuid, e.Content, blockID)
			if err != nil {
				logger.Warn("smart-image: transform base64 save failed", "block", blockID, "err", err)
				return nil
			}
			return map[string]interface{}{"src": filename}
		}
		// Raw SVG rendered locally by the JS frontend via resolveEntries
		if e.MIMEType == "image/svg+xml" {
			filename, err := p.saveSVG(uuid, e.Content, blockID)
			if err != nil {
				logger.Warn("smart-image: transform svg save failed", "block", blockID, "err", err)
				return nil
			}
			// SVG has no intrinsic pixel size; set a default so it is visible immediately.
			return map[string]interface{}{"src": filename, "width": "400"}
		}
		// Image URL (paste or extract from HTML)
		s := strings.TrimSpace(e.Content)
		if isImageURL(s) {
			// If it's already a local sieve asset, just use the filename
			if strings.HasPrefix(s, "/sieve/") || strings.Contains(s, "/sieve/") {
				parts := strings.Split(s, "/")
				filename := parts[len(parts)-1]
				// Remove query params if any
				if idx := strings.Index(filename, "?"); idx != -1 {
					filename = filename[:idx]
				}
				return map[string]interface{}{"src": filename}
			}

			filename, err := p.downloadImage(uuid, s, blockID)
			if err != nil {
				logger.Warn("smart-image: transform download failed", "block", blockID, "url", s, "err", err)
				return nil
			}
			return map[string]interface{}{"src": filename}
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				filename, err := p.downloadImage(uuid, src, blockID)
				if err != nil {
					logger.Warn("smart-image: transform html-img download failed", "block", blockID, "url", src, "err", err)
					return nil
				}
				return map[string]interface{}{"src": filename}
			}
		}
		// Mermaid source arriving without JS pre-processing — cannot render server-side.
		// resolveEntries in SmartImageRenderer must convert mermaid to SVG before this is called.
		if block.MermaidFenceRe.MatchString(e.Content) {
			logger.Warn("smart-image: mermaid source reached Transform unresolved; resolveEntries must render SVG locally", "block", blockID)
			return nil
		}
	}
	return nil
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

// DescribeJob is AI-only. The image file is already saved; Work calls DescribeImage
// and Apply writes the description attrs. The error path (status ERROR) is the
// framework's job, so Apply is success-only.
func (p *SmartImageProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	uuid, blk := jctx.UUID, jctx.Block
	src, _ := blk.Attrs["src"].(string)
	id := blk.ID
	return block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Describing image…",
		Work: func() (any, error) {
			if src == "" {
				logger.Warn("smart-image: DescribeJob called with no src", "block", id)
				return nil, fmt.Errorf("no image src to describe")
			}
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

func (p *SmartImageProcessor) saveBase64(uuid, dataUrl, blockID string) (string, error) {
	parts := strings.SplitN(dataUrl, ",", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid data URL format (no comma separator)")
	}

	b64 := strings.NewReplacer("\n", "", "\r", "", " ", "").Replace(parts[1])

	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		raw, err = base64.URLEncoding.DecodeString(b64)
		if err != nil {
			logger.Warn("smart-image: base64 decode failed", "block", blockID, "b64_len", len(b64), "err", err)
			return "", fmt.Errorf("base64 decode: %w", err)
		}
	}

	_, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		logger.Warn("smart-image: not a valid image", "block", blockID, "raw_len", len(raw), "err", err)
		return "", fmt.Errorf("invalid image data: %v", err)
	}
	logger.Info("smart-image: decoded image", "block", blockID, "format", format, "bytes", len(raw))

	return p.saveAsset(uuid, blockID, raw)
}

// saveSVG saves raw SVG content (locally rendered — never from an external server).
// Returns the asset filename. Callers should set a default display width since SVG
// has no intrinsic pixel size the browser can use before layout.
func (p *SmartImageProcessor) saveSVG(uuid, svgContent, blockID string) (string, error) {
	return p.saveAsset(uuid, blockID, []byte(svgContent))
}

func (p *SmartImageProcessor) downloadImage(uuid, url, blockID string) (string, error) {
	logger.Info("smart-image: downloading", "block", blockID, "url", url)
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("download failed, status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	// SVG is XML text — image.DecodeConfig only handles raster formats.
	trimmed := bytes.TrimSpace(raw)
	if bytes.HasPrefix(trimmed, []byte("<svg")) || bytes.HasPrefix(trimmed, []byte("<?xml")) {
		return p.saveAsset(uuid, blockID, raw)
	}

	_, _, err = image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("invalid image data: %v", err)
	}

	return p.saveAsset(uuid, blockID, raw)
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
