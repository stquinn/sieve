package sieve

import (
	"sieve/sieve/block"
	"strings"
	"time"
)

// mermaidFenceRe aliases the shared pattern so this file reads naturally.
var mermaidFenceRe = block.MermaidFenceRe

// DiagramProcessor handles the 'diagram' block kind.
// Rendering is entirely client-side; no async server job is needed.
// InitAttrs sets status: COMPLETE directly so DispatchJobIfNeeded skips dispatch.
type DiagramProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewDiagramProcessor(svc block.BlockServices) *DiagramProcessor {
	return &DiagramProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "diagram"}}
}

func (p *DiagramProcessor) IDPrefix() string { return "dia" }

func (p *DiagramProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *DiagramProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusComplete,
		"source":            "",
		"diagramType":       "mermaid",
		"mode":              "render",
		"cursorPos":         0,
		"supportsEmbedding": true,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	// Empty source → open in edit mode so the user can type immediately
	source, _ := attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		attrs["mode"] = "edit"
	}
	return attrs
}

func (p *DiagramProcessor) IsBlock(entries []block.ContentEntry) bool {
	for _, e := range entries {
		if mermaidFenceRe.MatchString(e.Content) {
			return true
		}
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			blk := block.ParseFirstBlock(e.Content)

			if blk == nil {
				continue
			}
			if blk.Attrs["language"] == "mermaid" && strings.TrimSpace(blk.Attrs["source"].(string)) != "" {
				return true
			}
		}
	}
	return false
}

func (p *DiagramProcessor) Transform(entries []block.ContentEntry, _ string, _ string) map[string]interface{} {
	for _, e := range entries {
		m := mermaidFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			return map[string]interface{}{"source": strings.TrimSpace(m[1])}
		}
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			blk := block.ParseFirstBlock(e.Content)
			if blk == nil {
				continue
			}
			if source, ok := blk.Attrs["source"]; ok {
				if language, ok := blk.Attrs["language"]; ok && language == "mermaid" && strings.TrimSpace(source.(string)) != "" {
					return map[string]interface{}{"source": source.(string)}
				}
			}
		}
	}
	return nil
}

func (p *DiagramProcessor) OnChange(_ *block.SieveBlock) {}

func (p *DiagramProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) string {
	src, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return ""
	}
	return "NODE ID: " + blk.ID + "\n\n```mermaid\n" + src + "\n```"
}

func (p *DiagramProcessor) JobLabel(_ *block.SieveBlock) string { return "" }

func (p *DiagramProcessor) RunJob(jctx block.JobContext) error {
	jctx.Block.Attrs["status"] = block.BlockStatusComplete
	return nil
}

func (p *DiagramProcessor) MarkdownRepresentation(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	return "```mermaid\n" + src + "\n```"
}
