package processors

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"strings"
	"time"
)

// SmartCardProcessor handles the 'smart-card' block kind.
// It fetches Open Graph metadata for a URL and stores the result as block attrs.
// Image download is best-effort; failures are non-fatal.
type SmartCardProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewSmartCardProcessor(svc block.BlockServices) *SmartCardProcessor {
	return &SmartCardProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "smart-card"}}
}
func (p *SmartCardProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *SmartCardProcessor) IDPrefix() string { return "crd" }

func (p *SmartCardProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *SmartCardProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"href":              "",
		"title":             "",
		"description":       "",
		"image":             "",
		"siteName":          "",
		"fetchedAt":         "",
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
	return attrs
}

func (p *SmartCardProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		trimmed := strings.TrimSpace(e.Content)
		if trimmed == "" || strings.ContainsAny(trimmed, " \t\n\r") {
			continue
		}
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
			continue
		}
		if isImageURL(trimmed) {
			continue
		}
		return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *SmartCardProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		trimmed := strings.TrimSpace(e.Content)
		if trimmed != "" && (strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://")) && !strings.ContainsAny(trimmed, " \t\n\r") {
			return map[string]interface{}{"href": trimmed}
		}
	}
	return nil
}

func (p *SmartCardProcessor) OnChange(_ *block.SieveBlock) {}

func (p *SmartCardProcessor) JobLabel(blk *block.SieveBlock) string {
	href, _ := blk.Attrs["href"].(string)
	if href == "" {
		return "Fetching link…"
	}
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		return "Fetching " + u.Hostname()
	}
	return "Fetching link…"
}

func (p *SmartCardProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	href, _ := blk.Attrs["href"].(string)
	if href == "" {
		return block.AIContext{}
	}
	title, _ := blk.Attrs["title"].(string)
	desc, _ := blk.Attrs["description"].(string)
	site, _ := blk.Attrs["siteName"].(string)

	var sb strings.Builder
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
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
}

func (p *SmartCardProcessor) RunJob(jctx block.JobContext) error {
	blk := jctx.Block
	href, _ := blk.Attrs["href"].(string)
	now := time.Now().UTC().Format(time.RFC3339)

	if href == "" {
		blk.Attrs["status"] = block.BlockStatusComplete
		blk.Attrs["completedAt"] = now
		blk.Attrs["fetchedAt"] = now
		return nil
	}

	result := p.svc.LinkPreview.FetchFull(href)

	blk.Attrs["title"] = result.Title
	blk.Attrs["description"] = result.Description
	blk.Attrs["siteName"] = result.SiteName

	if result.OGImageURL != "" && p.svc.Assets != nil && p.svc.Documents != nil {
		if ref, err := p.downloadImage(jctx.UUID, blk.ID, result.OGImageURL); err == nil {
			blk.Attrs["image"] = ref
		}
		// image download failure is non-fatal
	}

	blk.Attrs["status"] = block.BlockStatusComplete
	blk.Attrs["completedAt"] = now
	blk.Attrs["fetchedAt"] = now
	return nil
}

func (p *SmartCardProcessor) downloadImage(uuid, blockID, imageURL string) (string, error) {
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

	cat := domain.WorkingCopy
	if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil && d.Kind() == domain.KindNote {
		cat = domain.LibraryCategory
	}

	asset, err := p.svc.Assets.Save(cat, uuid, blockID+"-img", data)
	if err != nil {
		return "", fmt.Errorf("save image asset: %w", err)
	}
	return asset.ExternalRef(), nil
}

func (p *SmartCardProcessor) MarkdownRepresentation(blk block.SieveBlock) string {
	href, _ := blk.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	title, _ := blk.Attrs["title"].(string)
	if strings.TrimSpace(title) == "" {
		title = href
	}
	siteName, _ := blk.Attrs["siteName"].(string)
	description, _ := blk.Attrs["description"].(string)

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
