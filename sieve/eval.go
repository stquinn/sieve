package sieve

import (
	"strings"
)

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
