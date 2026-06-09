package sieve

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
)

// SmartImageProcessor handles the 'smart-image' Kind.
// PasteMatch saves the image file synchronously so the block is created with
// src already set. RunJob is AI-only: it calls DescribeImage on the saved file.
type SmartImageProcessor struct{ svc BlockServices }

func NewSmartImageProcessor(svc BlockServices) *SmartImageProcessor {
	return &SmartImageProcessor{svc: svc}
}

func (p *SmartImageProcessor) Mode() BlockMode  { return BlockModeBlock }
func (p *SmartImageProcessor) IDPrefix() string { return "img" }

func (p *SmartImageProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":      id,
		"src":     "",
		"alt":     "",
		"summary": "",
		"detect":  "",
		"width":   "",
		"height":  "",
		"status":  BlockStatusComplete, // default: no job unless src is provided
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
		attrs["status"] = BlockStatusPending
		attrs["createdAt"] = time.Now().UTC().Format(time.RFC3339)
	}
	return attrs
}

func (p *SmartImageProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			return true
		}
		// Raw SVG rendered locally by the JS frontend (resolveEntries)
		if e.MIMEType == "image/svg+xml" {
			return true
		}
		if isImageURL(strings.TrimSpace(e.Content)) {
			return true
		}
		// Mermaid source — JS resolveEntries will render it to SVG before Transform is called
		if MermaidFenceRe.MatchString(e.Content) {
			return true
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				return true
			}
		}
	}
	return false
}

func (p *SmartImageProcessor) Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{} {
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
		if MermaidFenceRe.MatchString(e.Content) {
			logger.Warn("smart-image: mermaid source reached Transform unresolved; resolveEntries must render SVG locally", "block", blockID)
			return nil
		}
	}
	return nil
}

func (p *SmartImageProcessor) OnChange(_ *SieveBlock) {}

func (p *SmartImageProcessor) BuildContext(block SieveBlock, _ ShadowDocument, seen map[string]bool) string {
	src, _ := block.Attrs["src"].(string)
	alt, _ := block.Attrs["alt"].(string)
	summary, _ := block.Attrs["summary"].(string)
	if src == "" {
		return ""
	}
	filename := filepath.Base(src)
	var sb strings.Builder
	sb.WriteString("NODE ID: " + block.ID + "\n\n")
	sb.WriteString("Image: " + filename + "\n")
	if alt != "" {
		sb.WriteString("Alt: " + alt + "\n")
	}
	if summary != "" {
		sb.WriteString("Summary: " + summary)
	}
	return sb.String()
}

func (p *SmartImageProcessor) JobLabel(_ *SieveBlock) string { return "Describing image…" }

// RunJob is AI-only. The image file is already saved; this calls DescribeImage.
func (p *SmartImageProcessor) RunJob(jctx JobContext) error {
	uuid, block := jctx.UUID, jctx.Block
	src, _ := block.Attrs["src"].(string)
	if src == "" {
		logger.Warn("smart-image: RunJob called with no src", "block", block.ID)
		block.Attrs["status"] = BlockStatusError
		return fmt.Errorf("no image src to describe")
	}

	logger.Info("smart-image: calling DescribeImage", "block", block.ID, "src", src)
	desc, err := p.svc.AI.DescribeImage(uuid, src, block.ID)
	if err != nil {
		logger.Warn("smart-image: DescribeImage failed", "block", block.ID, "err", err)
		block.Attrs["summary"] = "AI Description failed: " + err.Error()
		block.Attrs["status"] = BlockStatusError
		return err
	}

	logger.Info("smart-image: DescribeImage complete", "block", block.ID, "summary_len", len(desc.Summary))
	block.Attrs["summary"] = desc.Summary
	block.Attrs["alt"] = desc.Alt
	block.Attrs["detect"] = desc.Detect
	block.Attrs["status"] = BlockStatusComplete
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func isImageURL(s string) bool {
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "/") && !strings.Contains(s, "/sieve/") {
		return false
	}
	if strings.ContainsAny(s, " \t\n\r") {
		return false
	}
	lower := strings.ToLower(s)
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
	cat := WorkingCopy
	var doc Document
	if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		doc = d
		if doc.Kind() == KindNote {
			cat = Library
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

func (p *SmartImageProcessor) MarkdownRepresentation(block SieveBlock) string {
	src, _ := block.Attrs["src"].(string)
	if src == "" {
		return ""
	}
	alt, _ := block.Attrs["alt"].(string)
	if strings.TrimSpace(alt) == "" {
		alt, _ = block.Attrs["summary"].(string)
	}
	return "![" + strings.TrimSpace(alt) + "](" + src + ")"
}
