package sieve

import (
	"net/url"
	"strings"
	"time"
)

// SmartLinkProcessor handles the 'smart-link' block kind.
type SmartLinkProcessor struct{ svc BlockServices
	InlineSerializer // inline flavour: [!kind] {json} [!kind-end]
}

func NewSmartLinkProcessor(svc BlockServices) *SmartLinkProcessor {
	return &SmartLinkProcessor{svc: svc}
}

func (p *SmartLinkProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":          id,
		"href":        "",
		"label":       "",
		"status":      BlockStatusPending,
		"createdAt":   time.Now().UTC().Format(time.RFC3339),
		"completedAt": "",
		"error":       "",
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	if label, _ := attrs["label"].(string); label == "" {
		if href, _ := attrs["href"].(string); href != "" {
			attrs["label"] = href
		}
	}
	return attrs
}

func (p *SmartLinkProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		trimmed := strings.TrimSpace(e.Content)
		if trimmed == "" || strings.ContainsAny(trimmed, " \t\n\r") {
			continue
		}
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
			continue
		}
		// Defer image URLs to SmartImageProcessor
		if isImageURL(trimmed) {
			continue
		}
		return true
	}
	return false
}

func (p *SmartLinkProcessor) Transform(entries []ContentEntry, _ string, _ string) map[string]interface{} {
	for _, e := range entries {
		trimmed := strings.TrimSpace(e.Content)
		if trimmed != "" && (strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://")) && !strings.ContainsAny(trimmed, " \t\n\r") {
			return map[string]interface{}{"href": trimmed, "label": trimmed}
		}
	}
	return nil
}

func (p *SmartLinkProcessor) OnChange(_ *SieveBlock) {}

func (p *SmartLinkProcessor) IDPrefix() string { return "lnk" }

func (p *SmartLinkProcessor) Mode() BlockMode {
	return BlockModeInline
}

func (p *SmartLinkProcessor) BuildContext(block SieveBlock, _ DocView, seen map[string]bool) string {
	href, _ := block.Attrs["href"].(string)
	label, _ := block.Attrs["label"].(string)
	if href == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("NODE ID: " + block.ID + "\n\n")
	sb.WriteString("Link: " + href + "\n")
	if label != "" && label != href {
		sb.WriteString("Label: " + label)
	}
	return sb.String()
}

func (p *SmartLinkProcessor) JobLabel(block *SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	host := href
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		host = u.Host
	}
	return "Fetching " + host
}

func (p *SmartLinkProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	href, _ := block.Attrs["href"].(string)
	now := time.Now().UTC().Format(time.RFC3339)

	if href == "" {
		block.Attrs["status"] = BlockStatusComplete
		block.Attrs["completedAt"] = now
		return nil
	}

	title := p.svc.LinkPreview.FetchTitle(href)
	if title == "" {
		title = href
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["label"] = title
	block.Attrs["completedAt"] = now
	return nil
}

func (p *SmartLinkProcessor) MarkdownRepresentation(block SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	label, _ := block.Attrs["label"].(string)
	if label == "" || label == href {
		return href
	}
	return "[" + label + "](" + href + ")"
}
