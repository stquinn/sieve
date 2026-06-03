package sieve

import (
	"context"
	"net/url"
	"strings"
	"time"
)

// SmartLinkProcessor handles the 'smart-link' block kind.
// Pasting a bare URL (http:// or https://) creates this block. RunJob uses
// LinkPreviewService to fetch the page title — no AI service is involved.
type SmartLinkProcessor struct{}

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

// PasteMatch returns true for a clipboard that contains a single bare URL
// (http:// or https://) and nothing else. Multi-line pastes and prose text
// are not matched so that paragraph text containing a URL is not swallowed.
func (p *SmartLinkProcessor) PasteMatch(entries []PasteEntry) (bool, map[string]interface{}) {
	var content string
	for _, e := range entries {
		if e.MIMEType == "text/plain" {
			content = e.Content
			break
		}
	}
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return false, nil
	}
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		return false, nil
	}
	if strings.ContainsAny(trimmed, " \t\n\r") {
		return false, nil
	}
	return true, map[string]interface{}{"href": trimmed, "label": trimmed}
}

func (p *SmartLinkProcessor) OnChange(block *SieveBlock, _ Services) {}

func (p *SmartLinkProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	href, _ := block.Attrs["href"].(string)
	label, _ := block.Attrs["label"].(string)
	if label != "" && label != href {
		return "[" + label + "](" + href + ")"
	}
	return href
}

func (p *SmartLinkProcessor) JobLabel(block *SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	host := href
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		host = u.Host
	}
	return "Fetching " + host
}

func (p *SmartLinkProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, svc Services) error {
	href, _ := block.Attrs["href"].(string)
	now := time.Now().UTC().Format(time.RFC3339)

	if href == "" {
		block.Attrs["status"] = BlockStatusComplete
		block.Attrs["completedAt"] = now
		return nil
	}

	title := svc.LinkPreview.FetchTitle(href)
	if title == "" {
		title = href
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["label"] = title
	block.Attrs["completedAt"] = now
	return nil
}
