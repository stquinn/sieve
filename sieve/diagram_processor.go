package sieve

import (
	"regexp"
	"strings"
	"time"
)

var mermaidFenceRe = regexp.MustCompile("(?s)^```mermaid\n(.+)\n```$")

// DiagramProcessor handles the 'diagram' block kind.
// Rendering is entirely client-side; no async server job is needed.
// InitAttrs sets status: COMPLETE directly so DispatchJobIfNeeded skips dispatch.
type DiagramProcessor struct{ svc BlockServices }

func NewDiagramProcessor(svc BlockServices) *DiagramProcessor {
	return &DiagramProcessor{svc: svc}
}

func (p *DiagramProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *DiagramProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            BlockStatusComplete,
		"source":            "",
		"diagramType":       "mermaid",
		"mode":              "render",
		"cursorPos":         0,
		"supportsPromotion": true,
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

func (p *DiagramProcessor) PasteMatch(entries []PasteEntry, _ string, _ string) (bool, map[string]interface{}) {
	var content string
	for _, e := range entries {
		if e.MIMEType == "text/plain" {
			content = e.Content
			break
		}
	}
	if content == "" {
		return false, nil
	}
	m := mermaidFenceRe.FindStringSubmatch(strings.TrimSpace(content))
	if m == nil {
		return false, nil
	}
	return true, map[string]interface{}{
		"source": strings.TrimSpace(m[1]),
		"mode":   "render",
	}
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
