package sieve

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

var codeFenceRe = regexp.MustCompile("(?s)^```(\\w*)\\n(.+)\\n```$")

const minSourceLength = 30

// CodeBlockProcessor handles the 'code' Kind.
type CodeBlockProcessor struct{ svc BlockServices }

func NewCodeBlockProcessor(svc BlockServices) *CodeBlockProcessor {
	return &CodeBlockProcessor{svc: svc}
}

func (p *CodeBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":              id,
		"status":          BlockStatusPending,
		"source":          "",
		"language":        "",
		"detectionMethod": "",
		"createdAt":       time.Now().UTC().Format(time.RFC3339),
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
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
	}
	return false
}

func (p *CodeBlockProcessor) Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{} {
	for _, e := range entries {
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
	}
	return nil
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

func (p *CodeBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument, seen map[string]bool) string {
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
	return "```" + lang + "\n" + source + "\n```"
}
