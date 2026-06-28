package processors

import (
	"fmt"
	"regexp"
	"sieve/logger"
	"sieve/sieve/block"
	"strings"
	"time"
)

// codeFenceRe matches a fenced code block. The fence may be 3 or more backticks:
// the editor sizes fences longer than any backtick run in the content, so a code
// block that itself contains ``` arrives wrapped in 4+ ticks.
var codeFenceRe = regexp.MustCompile("(?s)^`{3,}(\\w*)\\n(.+)\\n`{3,}$")

const minSourceLength = 30

// CodeBlockProcessor handles the 'code' Kind.
type CodeBlockProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewCodeBlockProcessor(svc block.BlockServices) *CodeBlockProcessor {
	return &CodeBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "code"}}
}

func (p *CodeBlockProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *CodeBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusPending,
		"source":            "",
		"language":          "",
		"detectionMethod":   "",
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}

	logger.Debug("CodeBlockProcessor InitAttrs: initial attrs: %+v", attrs)
	source, _ := attrs["source"].(string)
	hint, _ := attrs["hint"].(string)
	if lang, ok := block.DetectByHeuristics(source, hint); ok {
		attrs["language"] = lang
		attrs["detectionMethod"] = "heuristic"
	}
	return attrs
}

func (p *CodeBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		m := codeFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			if m[1] == "mermaid" {
				continue
			}
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
				}
			}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if _, ok := unfencedCodeContent(e); ok {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *CodeBlockProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	// A typed sieve/diagram view wins over the generic text heuristics below — a
	// diagram's raw source could otherwise be claimed as plain code, losing its
	// mermaid language. Scan for it across all entries first.
	for _, e := range entries {

		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			//TODO: examine why we care if the type is mermaid - diagrams - have code... why do we care if mermaid
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return map[string]interface{}{
						"language":        "mermaid",
						"source":          strings.TrimSpace(src),
						"detectionMethod": "Converted from diagram block",
						"status":          block.BlockStatusComplete,
					}
				}
			}
		}
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		m := codeFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			lang := m[1]
			if lang == "mermaid" {
				continue
			}
			return map[string]interface{}{
				"language": lang,
				"source":   strings.TrimSpace(m[2]),
			}
		}

		if src, ok := unfencedCodeContent(e); ok {
			return map[string]interface{}{"source": src}
		}
	}

	return nil
}

// unfencedCodeContent returns the trimmed source of the first text entry that is
// NOT a code fence but still reads as code — either a heuristic language match or
// structural cues (braces, semicolons, indentation). This restores the smart-paste
// behaviour the pre-framework PasteMatch had: raw, unfenced source pasted into the
// editor still becomes a code block. Language is left to heuristics/AI in InitAttrs.
func unfencedCodeContent(entry block.ContentEntry) (string, bool) {

	if entry.MIMEType != "" && entry.MIMEType != "text/plain" {
		return "", false
	}
	trimmed := strings.TrimSpace(entry.Content)
	// Skip empties and anything that is itself a fence (handled / intentionally
	// skipped above, e.g. mermaid) so we never claim a fenced block as raw code.
	if trimmed == "" || codeFenceRe.MatchString(trimmed) {
		return "", false
	}
	if !strings.Contains(trimmed, "\n") {
		return "", false
	}
	if _, ok := block.DetectByHeuristics(trimmed, ""); ok {
		return trimmed, true
	}
	if block.LooksLikeCode(trimmed) {
		return trimmed, true
	}
	return "", false
}

func (p *CodeBlockProcessor) OnChange(blk *block.SieveBlock) {
	status, _ := blk.Attrs["status"].(string)
	if status == block.BlockStatusDispatched {
		return
	}

	source, _ := blk.Attrs["source"].(string)
	if len(strings.TrimSpace(source)) < minSourceLength {
		return
	}

	hint, _ := blk.Attrs["hint"].(string)
	if detected, ok := block.DetectByHeuristics(source, hint); ok {
		lang, _ := blk.Attrs["language"].(string)
		if detected != lang {
			blk.Attrs["language"] = detected
			blk.Attrs["detectionMethod"] = "heuristic"
		}
		return
	}

	lang, _ := blk.Attrs["language"].(string)
	if lang != "" && lang != "unknown" {
		return
	}

	if status == block.BlockStatusPending {
		return
	}

	blk.Attrs["status"] = block.BlockStatusPending
}

func (p *CodeBlockProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	src, _ := blk.Attrs["source"].(string)
	language, _ := blk.Attrs["language"].(string)
	if src == "" {
		return block.AIContext{}
	}
	ctx := block.AIContext{NodeIDs: []string{blk.ID}, Content: "```" + language + "\n" + src + "\n```"}
	return ctx
}

func (p *CodeBlockProcessor) JobLabel(_ *block.SieveBlock) string {
	return "Refining language..."
}

func (p *CodeBlockProcessor) IDPrefix() string { return "cod" }

func (p *CodeBlockProcessor) Mode() block.BlockMode {
	return block.BlockModeBlock
}

func (p *CodeBlockProcessor) RunJob(jctx block.JobContext) error {
	blk := jctx.Block
	source, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		blk.Attrs["status"] = block.BlockStatusComplete
		delete(blk.Attrs, "hint")
		return nil
	}

	if p.svc.AI == nil {
		blk.Attrs["status"] = block.BlockStatusError
		return fmt.Errorf("AI detection failed: AI service unavailable")
	}

	currentLang, _ := blk.Attrs["language"].(string)
	method, _ := blk.Attrs["detectionMethod"].(string)
	lang, err := p.svc.AI.RefineLanguage(source, currentLang, method)
	if err != nil {
		blk.Attrs["status"] = block.BlockStatusError
		return fmt.Errorf("AI detection failed: %w", err)
	}
	if lang != "" {
		blk.Attrs["language"] = lang
		blk.Attrs["detectionMethod"] = "ai"
	}
	blk.Attrs["status"] = block.BlockStatusComplete
	delete(blk.Attrs, "hint")
	return nil
}

// RawContent returns the source text this block was built from (block.RawContenter).
func (p *CodeBlockProcessor) RawContent(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	return src
}

func (p *CodeBlockProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	source, _ := blk.Attrs["source"].(string)
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	lang, _ := blk.Attrs["language"].(string)
	fence := getFence(source)
	return fence + lang + "\n" + source + "\n" + fence
}

// Move this outside to the package level
var backtickRegex = regexp.MustCompile("`+")

func getFence(content string) string {
	runs := backtickRegex.FindAllString(content, -1)

	longest := 0
	for _, r := range runs {
		if len(r) > longest {
			longest = len(r)
		}
	}

	// You can use a simple max helper or manual comparison
	fenceLen := longest + 1
	if fenceLen < 3 {
		fenceLen = 3
	}

	return strings.Repeat("`", fenceLen)
}
