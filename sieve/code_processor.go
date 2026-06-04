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

func (p *CodeBlockProcessor) PasteMatch(entries []PasteEntry, uuid string, blockID string) (bool, map[string]interface{}) {
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
	trimmed := strings.TrimSpace(content)

	if m := codeFenceRe.FindStringSubmatch(trimmed); m != nil {
		overrides := map[string]interface{}{"source": m[2]}
		if m[1] != "" {
			overrides["hint"] = m[1]
		}
		return true, overrides
	}

	if strings.Contains(trimmed, "\n") {
		if _, ok := detectByHeuristics(trimmed, ""); ok {
			return true, map[string]interface{}{"source": trimmed}
		}
		if looksLikeCode(trimmed) {
			return true, map[string]interface{}{"source": trimmed}
		}
	}

	return false, nil
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

	lang, err := p.svc.AI.RefineLanguage(source)
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
