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

// PasteMatch detects image content, saves the file synchronously, and returns
// {src: filename} so CreateBlock has the path before the block is inserted.
func (p *SmartImageProcessor) PasteMatch(entries []PasteEntry, uuid string, blockID string) (bool, map[string]interface{}) {
	for _, e := range entries {
		// Base64 data URL (from FileReader on clipboard file)
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			filename, err := p.saveBase64(uuid, e.Content, blockID)
			if err != nil {
				logger.Warn("smart-image: paste save failed", "block", blockID, "err", err)
				return false, nil
			}
			return true, map[string]interface{}{"src": filename}
		}

		// Image URL (bare URL ending in image extension)
		if e.MIMEType == "text/plain" || e.MIMEType == "text/uri-list" {
			s := strings.TrimSpace(e.Content)
			if isImageURL(s) {
				filename, err := p.downloadImage(uuid, s, blockID)
				if err != nil {
					logger.Warn("smart-image: paste download failed", "block", blockID, "url", s, "err", err)
					return false, nil
				}
				return true, map[string]interface{}{"src": filename}
			}
		}

		// HTML containing a single remote image
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				filename, err := p.downloadImage(uuid, src, blockID)
				if err != nil {
					logger.Warn("smart-image: paste html-img download failed", "block", blockID, "url", src, "err", err)
					return false, nil
				}
				return true, map[string]interface{}{"src": filename}
			}
		}
	}
	return false, nil
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
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return false
	}
	if strings.ContainsAny(s, " \t\n\r") {
		return false
	}
	lower := strings.ToLower(s)
	return strings.HasSuffix(lower, ".png") || strings.HasSuffix(lower, ".jpg") ||
		strings.HasSuffix(lower, ".jpeg") || strings.HasSuffix(lower, ".gif") ||
		strings.HasSuffix(lower, ".webp")
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
