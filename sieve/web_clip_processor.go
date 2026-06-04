package sieve

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

// WebClipBlockProcessor handles the 'web-clip' Kind.
type WebClipBlockProcessor struct{ svc BlockServices }

func NewWebClipBlockProcessor(svc BlockServices) *WebClipBlockProcessor {
	return &WebClipBlockProcessor{svc: svc}
}

func (p *WebClipBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":          id,
		"source":      "",
		"title":       "",
		"mode":        "fetch",
		"status":      BlockStatusPending,
		"model":       "",
		"createdAt":   time.Now().UTC().Format(time.RFC3339),
		"completedAt": "",
		"content":     "",
		"error":       "",
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

func (p *WebClipBlockProcessor) PasteMatch(_ []PasteEntry, _ string, _ string) (bool, map[string]interface{}) {
	return false, nil
}

func (p *WebClipBlockProcessor) OnChange(_ *SieveBlock) {}

func (p *WebClipBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument, seen map[string]bool) string {
	source, _ := block.Attrs["source"].(string)
	title, _ := block.Attrs["title"].(string)
	content, _ := block.Attrs["content"].(string)
	if source == "" && content == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("NODE ID: " + block.ID + "\n\n")
	if source != "" {
		sb.WriteString("Source: " + source + "\n")
	}
	if title != "" {
		sb.WriteString("Title: " + title + "\n")
	}
	if content != "" {
		sb.WriteString("\n" + content)
	}
	return sb.String()
}

func (p *WebClipBlockProcessor) JobLabel(block *SieveBlock) string {
	mode, _ := block.Attrs["mode"].(string)
	source, _ := block.Attrs["source"].(string)
	host := source
	if u, err := url.Parse(source); err == nil && u.Host != "" {
		host = u.Host
	}
	if mode == "summarise" {
		return "Summarising " + host
	}
	return "Fetching " + host
}

func (p *WebClipBlockProcessor) Mode() BlockMode {
	return BlockModeBlock
}

func (p *WebClipBlockProcessor) RunJob(jctx JobContext) error {
	uuid, block := jctx.UUID, jctx.Block
	source, _ := block.Attrs["source"].(string)
	mode, _ := block.Attrs["mode"].(string)
	if mode == "" {
		mode = "fetch"
	}

	var docContent string
	if doc, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		docContent = string(doc.Body())
	}

	if p.svc.AI == nil {
		block.Attrs["status"] = BlockStatusError
		block.Attrs["error"] = "AI service is unavailable"
		return fmt.Errorf("webclip RunJob failed: AI service is unavailable")
	}

	title, content, cliErr := p.svc.AI.RunWebClip(uuid, block.ID, source, mode, docContent)

	if cliErr != nil {
		if strings.Contains(cliErr.Error(), "timeout") {
			block.Attrs["status"] = "TIMEOUT"
		} else {
			block.Attrs["status"] = BlockStatusError
			block.Attrs["error"] = "Claude could not retrieve this page. Check that your MCP configuration can access this URL."
		}
		return cliErr
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["title"] = title
	block.Attrs["content"] = content
	block.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	block.Attrs["model"] = p.svc.AI.state.LoadSettings().Model

	return nil
}
