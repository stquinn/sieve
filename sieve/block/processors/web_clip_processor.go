package processors

import (
	"fmt"
	"net/url"
	"sieve/sieve/block"
	"strings"
	"time"
)

// WebClipBlockProcessor handles the 'web-clip' Kind.
type WebClipBlockProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewWebClipBlockProcessor(svc block.BlockServices) *WebClipBlockProcessor {
	return &WebClipBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "web-clip"}}
}

func (p *WebClipBlockProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *WebClipBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"source":            "",
		"title":             "",
		"mode":              "fetch",
		"status":            block.BlockStatusPending,
		"model":             "",
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"completedAt":       "",
		"content":           "",
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

func (p *WebClipBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		trimmed := strings.TrimSpace(e.Content)
		if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *WebClipBlockProcessor) AllowSelfExtraction() bool {
	return true
}

func (p *WebClipBlockProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		trimmed := strings.TrimSpace(e.Content)
		if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
			mode := "fetch" // default
			if e.Context != nil {
				if m, ok := e.Context["mode"].(string); ok && m != "" {
					mode = m
				}
			}
			return map[string]interface{}{
				"source": trimmed,
				"mode":   mode,
			}
		}
	}
	return nil
}

func (p *WebClipBlockProcessor) OnChange(_ *block.SieveBlock) {}

func (p *WebClipBlockProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	source, _ := blk.Attrs["source"].(string)
	title, _ := blk.Attrs["title"].(string)
	content, _ := blk.Attrs["content"].(string)
	if source == "" && content == "" {
		return block.AIContext{}
	}
	var sb strings.Builder
	if content != "" {
		sb.WriteString("\n" + content)
	}
	ctx := block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
	ctx.Tags = []block.Tag{
		{Label: "URL", Values: []string{source}},
		{Label: "Title", Values: []string{title}},
	}
	return ctx
}

// webClipLabel is the in-flight status label for a clip job (kind-qualified host).
func (p *WebClipBlockProcessor) webClipLabel(blk *block.SieveBlock) string {
	mode, _ := blk.Attrs["mode"].(string)
	source, _ := blk.Attrs["source"].(string)
	host := source
	if u, err := url.Parse(source); err == nil && u.Host != "" {
		host = u.Host
	}
	if mode == "summarise" {
		return "Summarising " + host
	}
	return "Fetching " + host
}

func (p *WebClipBlockProcessor) IDPrefix() string { return "web" }

func (p *WebClipBlockProcessor) Mode() block.BlockMode {
	return block.BlockModeBlock
}

// DescribeJob declares the AI clip job. The document body is read synchronously
// here (before the AI call, mirroring the old RunJob), then captured by Work. A
// web-clip always has async work (born PENDING), so DescribeJob never returns nil.
// Apply writes the success attrs; the error path (status ERROR/TIMEOUT) is the
// framework's job in EditorService.finish, so Apply is success-only.
func (p *WebClipBlockProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	uuid, blk := jctx.UUID, jctx.Block
	id := blk.ID
	source, _ := blk.Attrs["source"].(string)
	mode, _ := blk.Attrs["mode"].(string)
	if mode == "" {
		mode = "fetch"
	}

	var docContent string
	if doc, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		docContent = string(doc.Body())
	}

	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    p.webClipLabel(blk),
		Work: func() (any, error) {
			if p.svc.AI == nil {
				return nil, fmt.Errorf("webclip job failed: AI service is unavailable")
			}
			title, content, cliErr := p.svc.AI.RunWebClip(uuid, id, source, mode, docContent)
			if cliErr != nil {
				return nil, cliErr
			}
			return []string{title, content}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			tc := result.([]string)
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["title"] = tc[0]
			b.Attrs["content"] = tc[1]
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			b.Attrs["model"] = p.svc.State.LoadSettings().Model
		},
	}
}

// ExportMarkdown implements block.ExportRepresenter: for clean "Copy as Markdown"
// export a web-clip reduces to a plain link to its source. The clipped/summarised
// content is DERIVED — export keeps only the user-authored seed (the source URL the
// user pasted, plus the resolved title as link text), so a clip becomes
// `[title](source)`, or a bare URL when there is no title. Distinct from
// MarkdownRepresentation (which embeds the full content for AI context) by design.
func (p *WebClipBlockProcessor) ExportMarkdown(blk block.SieveBlock, _ string) string {
	source, _ := blk.Attrs["source"].(string)
	if source == "" {
		return ""
	}
	title, _ := blk.Attrs["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" {
		return source
	}
	return "[" + title + "](" + source + ")"
}

func (p *WebClipBlockProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	content, _ := blk.Attrs["content"].(string)
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	title, _ := blk.Attrs["title"].(string)
	source, _ := blk.Attrs["source"].(string)
	var sb strings.Builder
	if title != "" && source != "" {
		sb.WriteString("### [" + title + "](" + source + ")\n\n")
	} else if title != "" {
		sb.WriteString("### " + title + "\n\n")
	}
	sb.WriteString(content)
	return sb.String()
}
