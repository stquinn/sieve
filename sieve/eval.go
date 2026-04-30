package sieve

import (
	"path/filepath"
	"strings"
)

// FilingRecommendation mirrors the expected JSON structure from the AI.
type FilingRecommendation struct {
	Keep            bool     `json:"keep"`
	Title           string   `json:"title"`
	Filename        string   `json:"filename"`
	Folder          string   `json:"folder"`
	NewFolder       bool     `json:"new_folder"`
	Type            string   `json:"type"`
	Summary         string   `json:"summary"`
	Tags            []string `json:"tags"`
	AiJustification string   `json:"ai_justification"`
	DensitySignals  []string `json:"density_signals"`
}

// ImageDesc is the structured response from AIService.DescribeImage.
type ImageDesc struct {
	Filename string `json:"filename"`
	Alt      string `json:"alt"`
	Summary  string `json:"summary"`
	Detect   string `json:"detect,omitempty"`
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func detectContentType(content string) string {
	trimmed := strings.TrimSpace(content)
	if strings.HasPrefix(trimmed, "```") {
		firstLine := strings.SplitN(trimmed, "\n", 2)[0]
		lang := strings.TrimSpace(strings.TrimPrefix(firstLine, "```"))
		if lang != "" {
			return lang
		}
		return "code"
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return "json"
	}
	if strings.HasPrefix(trimmed, "apiVersion:") || strings.HasPrefix(trimmed, "kind:") {
		return "kubernetes yaml"
	}
	return "markdown"
}

func extractJSONFallback(text string) string {
	text = strings.TrimSpace(text)
	text = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(
		strings.TrimSpace(text), "```json\n"), "\n```"))
	text = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(
		strings.TrimSpace(text), "```\n"), "\n```"))

	if strings.HasPrefix(text, "{") && strings.HasSuffix(text, "}") {
		return text
	}
	first := strings.Index(text, "{")
	last := strings.LastIndex(text, "}")
	if first >= 0 && last >= 0 && last > first {
		return text[first : last+1]
	}
	return text
}

// imageNameList builds the {images} prompt substitution: relative paths from
// noteCwd where possible, otherwise just the base filename.
func imageNameList(imagePaths []string, noteCwd string) string {
	if len(imagePaths) == 0 {
		return "N/A"
	}
	names := make([]string, len(imagePaths))
	for i, p := range imagePaths {
		if rel, err := filepath.Rel(noteCwd, p); err == nil {
			names[i] = rel
		} else {
			names[i] = filepath.Base(p)
		}
	}
	return strings.Join(names, ", ")
}
