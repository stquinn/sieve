package sieve

import (
	"fmt"
	"regexp"
	"sieve/logger"
	"strings"
	"time"
)

// codeFenceRe matches a fenced code block. The fence may be 3 or more backticks:
// the editor sizes fences longer than any backtick run in the content, so a code
// block that itself contains ``` arrives wrapped in 4+ ticks.
var codeFenceRe = regexp.MustCompile("(?s)^`{3,}(\\w*)\\n(.+)\\n`{3,}$")

const minSourceLength = 30

// CodeBlockProcessor handles the 'code' Kind.
type CodeBlockProcessor struct{ svc BlockServices
	FencedSerializer // one shared YAML serialization — free
}

func NewCodeBlockProcessor(svc BlockServices) *CodeBlockProcessor {
	return &CodeBlockProcessor{svc: svc}
}

func (p *CodeBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            BlockStatusPending,
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
	if lang, ok := detectByHeuristics(source, hint); ok {
		attrs["language"] = lang
		attrs["detectionMethod"] = "heuristic"
	}
	return attrs
}

func (p *CodeBlockProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		m := codeFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			lang := m[1]
			if lang == "mermaid" {
				continue
			}
			return true
		}
		if e.MIMEType == "sieve/diagram" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)
			if block != nil && block.Attrs["diagramType"] == "mermaid" && strings.TrimSpace(block.Attrs["source"].(string)) != "" {
				logger.Debug("MATCHED DIAGRAM BLOCK AS CODE")
				return true
			}
		}
		if _, ok := unfencedCodeContent(e); ok {
			return true
		}
	}
	return false
}

func (p *CodeBlockProcessor) Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{} {
	for _, e := range entries {
		if e.MIMEType == "sieve/diagram" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)
			if block != nil {
				if block.Attrs["diagramType"] == "mermaid" && strings.TrimSpace(block.Attrs["source"].(string)) != "" {
					logger.Debug("TRANSFORMING DIAGRAM BLOCK AS CODE")
					return map[string]interface{}{
						"language":        "mermaid",
						"source":          strings.TrimSpace(block.Attrs["source"].(string)),
						"detectionMethod": "Converted from diagram block",
						"status":          BlockStatusComplete,
					}
				}
			}
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
func unfencedCodeContent(entry ContentEntry) (string, bool) {

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
	if _, ok := detectByHeuristics(trimmed, ""); ok {
		return trimmed, true
	}
	if looksLikeCode(trimmed) {
		return trimmed, true
	}
	return "", false
}

func (p *CodeBlockProcessor) OnChange(block *SieveBlock) {
	status, _ := block.Attrs["status"].(string)
	if status == BlockStatusDispatched {
		return
	}

	source, _ := block.Attrs["source"].(string)
	if len(strings.TrimSpace(source)) < minSourceLength {
		return
	}

	hint, _ := block.Attrs["hint"].(string)
	if detected, ok := detectByHeuristics(source, hint); ok {
		lang, _ := block.Attrs["language"].(string)
		if detected != lang {
			block.Attrs["language"] = detected
			block.Attrs["detectionMethod"] = "heuristic"
		}
		return
	}

	lang, _ := block.Attrs["language"].(string)
	if lang != "" && lang != "unknown" {
		return
	}

	if status == BlockStatusPending {
		return
	}

	block.Attrs["status"] = BlockStatusPending
}

func (p *CodeBlockProcessor) BuildContext(block SieveBlock, _ DocView, seen map[string]bool) string {
	src, _ := block.Attrs["source"].(string)
	language, _ := block.Attrs["language"].(string)
	if src != "" {
		return "NODE ID: " + block.ID + "\n\n" + "```" + language + "\n" + src + "\n```"
	}
	return ""
}

func (p *CodeBlockProcessor) JobLabel(_ *SieveBlock) string {
	return "Refining language..."
}

func (p *CodeBlockProcessor) IDPrefix() string { return "cod" }

func (p *CodeBlockProcessor) Mode() BlockMode {
	return BlockModeBlock
}

func (p *CodeBlockProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	source, _ := block.Attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		block.Attrs["status"] = BlockStatusComplete
		delete(block.Attrs, "hint")
		return nil
	}

	if p.svc.AI == nil {
		block.Attrs["status"] = BlockStatusError
		return fmt.Errorf("AI detection failed: AI service unavailable")
	}

	currentLang, _ := block.Attrs["language"].(string)
	method, _ := block.Attrs["detectionMethod"].(string)
	lang, err := p.svc.AI.RefineLanguage(source, currentLang, method)
	if err != nil {
		block.Attrs["status"] = BlockStatusError
		return fmt.Errorf("AI detection failed: %w", err)
	}
	if lang != "" {
		block.Attrs["language"] = lang
		block.Attrs["detectionMethod"] = "ai"
	}
	block.Attrs["status"] = BlockStatusComplete
	delete(block.Attrs, "hint")
	return nil
}

func (p *CodeBlockProcessor) MarkdownRepresentation(block SieveBlock) string {
	source, _ := block.Attrs["source"].(string)
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	lang, _ := block.Attrs["language"].(string)
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
