package sieve

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// RichLinkProcessor handles the 'rich-link' block kind.
// It fetches Open Graph metadata for a URL and stores the result as block attrs.
// Image download is best-effort; failures are non-fatal.
type RichLinkProcessor struct{ svc BlockServices }

func NewRichLinkProcessor(svc BlockServices) *RichLinkProcessor {
	return &RichLinkProcessor{svc: svc}
}

func (p *RichLinkProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *RichLinkProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"href":              "",
		"title":             "",
		"description":       "",
		"image":             "",
		"siteName":          "",
		"fetchedAt":         "",
		"status":            BlockStatusPending,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"completedAt":       "",
		"error":             "",
		"supportsPromotion": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

func (p *RichLinkProcessor) PasteMatch(_ []PasteEntry, _ string, _ string) (bool, map[string]interface{}) {
	return false, nil
}

func (p *RichLinkProcessor) OnChange(_ *SieveBlock) {}

func (p *RichLinkProcessor) JobLabel(block *SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return "Fetching link…"
	}
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		return "Fetching " + u.Hostname()
	}
	return "Fetching link…"
}

func (p *RichLinkProcessor) BuildContext(block SieveBlock, _ ShadowDocument, _ map[string]bool) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	title, _ := block.Attrs["title"].(string)
	desc, _ := block.Attrs["description"].(string)
	site, _ := block.Attrs["siteName"].(string)

	var sb strings.Builder
	sb.WriteString("NODE ID: " + block.ID + "\n\n")
	sb.WriteString("Link: " + href + "\n")
	if title != "" {
		sb.WriteString("Title: " + title + "\n")
	}
	if site != "" {
		sb.WriteString("Source: " + site + "\n")
	}
	if desc != "" {
		sb.WriteString("Description: " + desc + "\n")
	}
	return sb.String()
}

func (p *RichLinkProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	href, _ := block.Attrs["href"].(string)
	now := time.Now().UTC().Format(time.RFC3339)

	if href == "" {
		block.Attrs["status"] = BlockStatusComplete
		block.Attrs["completedAt"] = now
		block.Attrs["fetchedAt"] = now
		return nil
	}

	result := p.svc.LinkPreview.FetchFull(href)

	block.Attrs["title"] = result.Title
	block.Attrs["description"] = result.Description
	block.Attrs["siteName"] = result.SiteName

	if result.OGImageURL != "" && p.svc.Assets != nil && p.svc.Documents != nil {
		if ref, err := p.downloadImage(jctx.UUID, block.ID, result.OGImageURL); err == nil {
			block.Attrs["image"] = ref
		}
		// image download failure is non-fatal
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["completedAt"] = now
	block.Attrs["fetchedAt"] = now
	return nil
}

func (p *RichLinkProcessor) downloadImage(uuid, blockID, imageURL string) (string, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(imageURL)
	if err != nil {
		return "", fmt.Errorf("fetch image: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch image: status %d", resp.StatusCode)
	}

	// Read image with a 5MB size limit to prevent memory exhaustion
	limitReader := io.LimitReader(resp.Body, 5*1024*1024)
	data, err := io.ReadAll(limitReader)
	if err != nil {
		return "", fmt.Errorf("read image body: %w", err)
	}

	cat := WorkingCopy
	if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil && d.Kind() == KindNote {
		cat = Library
	}

	asset, err := p.svc.Assets.Save(cat, uuid, blockID+"-img", data)
	if err != nil {
		return "", fmt.Errorf("save image asset: %w", err)
	}
	return asset.ExternalRef(), nil
}

func (p *RichLinkProcessor) MarkdownRepresentation(block SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	title, _ := block.Attrs["title"].(string)
	if strings.TrimSpace(title) == "" {
		title = href
	}
	siteName, _ := block.Attrs["siteName"].(string)
	description, _ := block.Attrs["description"].(string)

	var sb strings.Builder
	sb.WriteString("### [" + strings.TrimSpace(title) + "](" + href + ")")
	if strings.TrimSpace(siteName) != "" {
		sb.WriteString("\n*" + strings.TrimSpace(siteName) + "*")
	}
	if strings.TrimSpace(description) != "" {
		sb.WriteString("\n\n" + strings.TrimSpace(description))
	}
	return sb.String()
}
