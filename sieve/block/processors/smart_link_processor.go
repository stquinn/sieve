package processors

import (
	"net/url"
	"sieve/sieve/block"
	"strings"
	"time"
)

// SmartLinkProcessor handles the 'smart-link' block kind.
type SmartLinkProcessor struct {
	svc                      block.BlockServices
	block.InlineSerializer   // inline flavour: [!kind] {json} [!kind-end]
	block.InlineDeserializer // inline things are not recognised from disk (project_inline_not_a_block)
}

func NewSmartLinkProcessor(svc block.BlockServices) *SmartLinkProcessor {
	return &SmartLinkProcessor{svc: svc}
}

func (p *SmartLinkProcessor) Kind() string { return "smart-link" }

func (p *SmartLinkProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":          id,
		"href":        "",
		"label":       "",
		"status":      block.BlockStatusPending,
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
	href, _ := attrs["href"].(string)
	if label, _ := attrs["label"].(string); label == "" && href != "" {
		attrs["label"] = href
	}
	// Complete-vs-pending predicate MUST mirror DescribeJob: no href ⇒ no fetch job
	// ⇒ born COMPLETE (never dispatched); an href present ⇒ PENDING.
	if href == "" {
		attrs["status"] = block.BlockStatusComplete
	}
	return attrs
}

func (p *SmartLinkProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
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

func (p *SmartLinkProcessor) Transform(entries []block.ContentEntry, _ string, _ string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		trimmed := strings.TrimSpace(e.Content)
		if trimmed != "" && (strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://")) && !strings.ContainsAny(trimmed, " \t\n\r") {
			return map[string]interface{}{"href": trimmed, "label": trimmed}
		}
	}
	return nil
}

func (p *SmartLinkProcessor) OnChange(_ *block.SieveBlock) {}

func (p *SmartLinkProcessor) IDPrefix() string { return "lnk" }

func (p *SmartLinkProcessor) Mode() block.BlockMode {
	return block.BlockModeInline
}

func (p *SmartLinkProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	href, _ := blk.Attrs["href"].(string)
	label, _ := blk.Attrs["label"].(string)
	if href == "" {
		return block.AIContext{}
	}
	var sb strings.Builder
	sb.WriteString("Link: " + href + "\n")
	if label != "" && label != href {
		sb.WriteString("Label: " + label)
	}
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
}

// smartLinkLabel is the in-flight status label for a title-fetch job.
func (p *SmartLinkProcessor) smartLinkLabel(blk *block.SieveBlock) string {
	href, _ := blk.Attrs["href"].(string)
	host := href
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		host = u.Host
	}
	return "Fetching " + host
}

// DescribeJob declares the title-fetch job, or nil when there is no href to fetch
// (the block is born COMPLETE by InitAttrs — same empty-href predicate). The
// blocking network fetch lives in Work; Apply writes the attrs (falling back to
// the href when no title is found), mirroring the old RunJob body.
func (p *SmartLinkProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	href, _ := blk.Attrs["href"].(string)

	if href == "" {
		return nil // no href: no fetch job (created COMPLETE)
	}

	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    p.smartLinkLabel(blk),
		Work: func() (any, error) {
			return p.svc.LinkPreview.FetchTitle(href), nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			title, _ := result.(string)
			if title == "" {
				title = href
			}
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["label"] = title
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
		},
	}
}

func (p *SmartLinkProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	href, _ := blk.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	label, _ := blk.Attrs["label"].(string)
	if label == "" || label == href {
		return href
	}
	return "[" + label + "](" + href + ")"
}
