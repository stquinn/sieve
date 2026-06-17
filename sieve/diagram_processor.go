package sieve

import (
	"strings"
	"time"
)

// mermaidFenceRe aliases the shared pattern so this file reads naturally.
var mermaidFenceRe = MermaidFenceRe

// DiagramProcessor handles the 'diagram' block kind.
// Rendering is entirely client-side; no async server job is needed.
// InitAttrs sets status: COMPLETE directly so DispatchJobIfNeeded skips dispatch.
type DiagramProcessor struct{ svc BlockServices }

func NewDiagramProcessor(svc BlockServices) *DiagramProcessor {
	return &DiagramProcessor{svc: svc}
}

func (p *DiagramProcessor) IDPrefix() string { return "dia" }

func (p *DiagramProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *DiagramProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            BlockStatusComplete,
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

func (p *DiagramProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		if mermaidFenceRe.MatchString(e.Content) {
			return true
		}
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)

			if block == nil {
				continue
			}
			if block.Attrs["language"] == "mermaid" && strings.TrimSpace(block.Attrs["source"].(string)) != "" {
				return true
			}
		}
	}
	return false
}

func (p *DiagramProcessor) Transform(entries []ContentEntry, _ string, _ string) map[string]interface{} {
	for _, e := range entries {
		m := mermaidFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			return map[string]interface{}{"source": strings.TrimSpace(m[1])}
		}
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)
			if block == nil {
				continue
			}
			if source, ok := block.Attrs["source"]; ok {
				if language, ok := block.Attrs["language"]; ok && language == "mermaid" && strings.TrimSpace(source.(string)) != "" {
					return map[string]interface{}{"source": source.(string)}
				}
			}
		}
	}
	return nil
}

func (p *DiagramProcessor) OnChange(_ *SieveBlock) {}

func (p *DiagramProcessor) BuildContext(block SieveBlock, _ ShadowDocument, _ map[string]bool) string {
	src, _ := block.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return ""
	}
	return "NODE ID: " + block.ID + "\n\n```mermaid\n" + src + "\n```"
}

func (p *DiagramProcessor) JobLabel(_ *SieveBlock) string { return "" }

func (p *DiagramProcessor) RunJob(jctx JobContext) error {
	jctx.Block.Attrs["status"] = BlockStatusComplete
	return nil
}

func (p *DiagramProcessor) MarkdownRepresentation(block SieveBlock) string {
	src, _ := block.Attrs["source"].(string)
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	return "```mermaid\n" + src + "\n```"
}
