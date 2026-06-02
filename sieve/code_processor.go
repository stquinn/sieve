package sieve

import (
	"context"
	"regexp"
	"strings"
)

var codeFenceRe = regexp.MustCompile("(?s)^```(\\w*)\\n(.+)\\n```$")

// CodeBlockProcessor handles the 'code' Kind.
type CodeBlockProcessor struct{}

// InitAttrs declares the code block schema and returns the complete initial
// YAML map. id is always set from the parameter — overrides cannot replace it.
// Heuristics run synchronously here so the user sees a language badge immediately
// when the block is inserted. RunJob (AI) then enriches silently in the background.
func (p *CodeBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":              id,
		"status":          "PENDING",
		"source":          "",
		"language":        "",
		"detectionMethod": "",
	}
	for k, v := range overrides {
		if k == "id" {
			continue // id is authoritative from parameter
		}
		attrs[k] = v
	}
	// Free-hit language detection: heuristics are fast and give the user something
	// useful immediately. Status stays PENDING — AI enrichment runs in RunJob.
	source, _ := attrs["source"].(string)
	hint, _ := attrs["hint"].(string)
	if lang, ok := detectByHeuristics(source, hint); ok {
		attrs["language"] = lang
		attrs["detectionMethod"] = "heuristic"
	}
	return attrs
}

// PasteMatch detects a bare fenced code block and returns the source and optional
// language hint as overrides for InitAttrs. It does NOT set id, status, or language.
func (p *CodeBlockProcessor) PasteMatch(content string) (bool, map[string]interface{}) {
	m := codeFenceRe.FindStringSubmatch(strings.TrimSpace(content))
	if m == nil {
		return false, nil
	}
	overrides := map[string]interface{}{"source": m[2]}
	if m[1] != "" {
		overrides["hint"] = m[1]
	}
	return true, overrides
}

func (p *CodeBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	src, _ := block.Attrs["source"].(string)
	return src
}

// RunJob enriches the language via AI and marks the block COMPLETE.
// Heuristics already ran in InitAttrs — RunJob calls RefineLanguage (AI-only)
// to potentially improve the result. If the AI returns empty, the heuristic
// result from InitAttrs is kept. hint is transient and deleted after use.
func (p *CodeBlockProcessor) RunJob(ctx context.Context, block *SieveBlock, svc Services) error {
	source, _ := block.Attrs["source"].(string)

	lang, err := svc.AI.RefineLanguage(source)
	if err != nil {
		// Non-fatal: heuristics may have already set a language. Mark complete
		// and keep whatever language is set rather than overwriting with "unknown".
		block.Attrs["status"] = "COMPLETE"
		delete(block.Attrs, "hint")
		return nil
	}
	if lang != "" {
		block.Attrs["language"] = lang
		block.Attrs["detectionMethod"] = "ai"
	}
	// If lang == "" AI was not confident — keep the heuristic result unchanged.
	block.Attrs["status"] = "COMPLETE"
	delete(block.Attrs, "hint")
	return nil
}
