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

func (p *WebClipBlockProcessor) JobLabel(blk *block.SieveBlock) string {
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

func (p *WebClipBlockProcessor) RunJob(jctx block.JobContext) error {
	uuid, blk := jctx.UUID, jctx.Block
	source, _ := blk.Attrs["source"].(string)
	mode, _ := blk.Attrs["mode"].(string)
	if mode == "" {
		mode = "fetch"
	}

	var docContent string
	if doc, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		docContent = string(doc.Body())
	}

	if p.svc.AI == nil {
		blk.Attrs["status"] = block.BlockStatusError
		blk.Attrs["error"] = "AI service is unavailable"
		return fmt.Errorf("webclip RunJob failed: AI service is unavailable")
	}

	title, content, cliErr := p.svc.AI.RunWebClip(uuid, blk.ID, source, mode, docContent)

	if cliErr != nil {
		if strings.Contains(cliErr.Error(), "timeout") {
			blk.Attrs["status"] = "TIMEOUT"
		} else {
			blk.Attrs["status"] = block.BlockStatusError
			blk.Attrs["error"] = "Claude could not retrieve this page. Check that your MCP configuration can access this URL."
		}
		return cliErr
	}

	blk.Attrs["status"] = block.BlockStatusComplete
	blk.Attrs["title"] = title
	blk.Attrs["content"] = content
	blk.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	blk.Attrs["model"] = p.svc.State.LoadSettings().Model

	return nil
}

func (p *WebClipBlockProcessor) MarkdownRepresentation(blk block.SieveBlock) string {
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
