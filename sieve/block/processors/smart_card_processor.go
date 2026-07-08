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
	// Complete-vs-pending predicate MUST mirror DescribeJob: no href ⇒ no fetch job
	// ⇒ born COMPLETE (never dispatched); an href present ⇒ PENDING.
	if href, _ := attrs["href"].(string); href == "" {
		attrs["status"] = block.BlockStatusComplete
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

func (p *SmartCardProcessor) smartCardLabel(blk *block.SieveBlock) string {
	href, _ := blk.Attrs["href"].(string)
	if href == "" {
		return "Fetching link…"
	}
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		return "Fetching " + u.Hostname()
	}
	return "Fetching link…"
}

// smartCardFetch is Work's result: the OG metadata plus a best-effort image ref.
type smartCardFetch struct {
	preview  domain.LinkPreviewResult
	imageRef string
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

// DescribeJob declares the OG-metadata fetch job, or nil when there is no href to
// fetch (the block is born COMPLETE by InitAttrs — same empty-href predicate). The
// blocking network work (OG fetch + best-effort image download) lives in Work;
// Apply writes the attrs, mirroring the old RunJob body.
func (p *SmartCardProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	uuid, id := jctx.UUID, blk.ID
	href, _ := blk.Attrs["href"].(string)

	if href == "" {
		return nil // no href: no fetch job (created COMPLETE)
	}

	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    p.smartCardLabel(blk),
		Work: func() (any, error) {
			result := p.svc.LinkPreview.FetchFull(href)
			imageRef := ""
			if result.OGImageURL != "" && p.svc.Assets != nil && p.svc.Documents != nil {
				if ref, err := p.downloadImage(uuid, id, result.OGImageURL); err == nil {
					imageRef = ref
				}
				// image download failure is non-fatal
			}
			return smartCardFetch{preview: result, imageRef: imageRef}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			f := result.(smartCardFetch)
			now := time.Now().UTC().Format(time.RFC3339)
			b.Attrs["title"] = f.preview.Title
			b.Attrs["description"] = f.preview.Description
			b.Attrs["siteName"] = f.preview.SiteName
			if f.imageRef != "" {
				b.Attrs["image"] = f.imageRef
			}
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["completedAt"] = now
			b.Attrs["fetchedAt"] = now
		},
	}
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

// ExportMarkdown implements block.ExportRepresenter: for clean "Copy as Markdown"
// export a URL card reduces to a plain link. The siteName/description are DERIVED
// (fetched) content — export keeps only the user-authored seed (the URL, plus the
// resolved title as the link text), so a card becomes `[title](href)`, or a bare URL
// when there is no title. This is deliberately distinct from MarkdownRepresentation,
// which AI context relies on and must keep its richer form.
func (p *SmartCardProcessor) ExportMarkdown(blk block.SieveBlock, _ string) string {
	href, _ := blk.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	title, _ := blk.Attrs["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" {
		return href
	}
	return "[" + title + "](" + href + ")"
}

func (p *SmartCardProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
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
