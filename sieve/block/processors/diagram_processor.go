package processors

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

func (p *DiagramProcessor) Kind() string { return p.FencedDeserializer.Kind }

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

func (p *DiagramProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if mermaidFenceRe.MatchString(e.Content) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			if lang, _ := attrs["language"].(string); lang == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste,
						block.ActionExtract, block.ActionTransform}}
				}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *DiagramProcessor) Transform(entries []block.ContentEntry, _ string, _ string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		m := mermaidFenceRe.FindStringSubmatch(e.Content)
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		if m != nil {
			return map[string]interface{}{"source": strings.TrimSpace(m[1])}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			if lang, _ := attrs["language"].(string); lang == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return map[string]interface{}{"source": src}
				}
			}
		}
	}
	return nil
}

func (p *DiagramProcessor) OnChange(_ *block.SieveBlock) {}

func (p *DiagramProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	src, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return block.AIContext{}
	}
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: "```mermaid\n" + src + "\n```"}
}

// DescribeJob: a diagram has no async work — it renders client-side and is
// created COMPLETE by InitAttrs, so it is never dispatched. nil == no job.
func (p *DiagramProcessor) DescribeJob(_ block.JobContext) *block.ProcessorJob {
	return nil
}

func (p *DiagramProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	src, _ := blk.Attrs["source"].(string)
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	return "```mermaid\n" + src + "\n```"
}

// RawContent returns the source text this block was built from (block.RawContenter).
func (p *DiagramProcessor) RawContent(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	return src
}
