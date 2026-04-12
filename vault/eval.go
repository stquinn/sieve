package vault

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// FilingRecommendation mirrors the expected JSON structure from the AI.
type FilingRecommendation struct {
	Keep      bool     `json:"keep"`
	Title     string   `json:"title"`
	Filename  string   `json:"filename"`
	Folder    string   `json:"folder"`
	NewFolder bool     `json:"new_folder"`
	Type      string   `json:"type"`
	Summary   string   `json:"summary"`
	Tags      []string `json:"tags"`
}

// getFilingPrompt retrieves the filing prompt template, substituting from
// vault/{hostname}/prompts/file.md if exists.
func (v *Vault) getFilingPrompt(settings Settings) string {
	if settings.Prompts.File != "" {
		b, err := os.ReadFile(filepath.Join(v.Root, settings.Prompts.File))
		if err == nil && len(b) > 0 {
			return string(b)
		}
	}
	return DefaultFilingPrompt
}

// EvaluateBuffer executes the AI evaluation over a buffer on disk and returns the
// unmarshaled recommendation.
func (v *Vault) EvaluateBuffer(path string, settings Settings) (*FilingRecommendation, error) {
	if settings.Tier() == TierDumb {
		return nil, fmt.Errorf("AI evaluation not available in Dumb mode")
	}

	contentBytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	content := string(contentBytes)

	// Extract frontmatter meta specifically for version and focus_count via regex
	versionStr := "1"
	focusCountStr := "1"
	
	if strings.HasPrefix(content, "---\n") {
		parts := strings.SplitN(content[4:], "\n---\n", 2)
		if len(parts) == 2 {
			metaStr := "---" + parts[0]
			
			if m := regexp.MustCompile(`(?m)^version:\s*(\d+)`).FindStringSubmatch(metaStr); len(m) > 1 {
				versionStr = m[1]
			}
			if m := regexp.MustCompile(`(?m)^focus_count:\s*(\d+)`).FindStringSubmatch(metaStr); len(m) > 1 {
				focusCountStr = m[1]
			}
			content = parts[1]
		}
	}

	// Read existing folders in notes/
	var folders []string
	entries := ScanNotes(v.Root, v.NotesPath())
	for _, e := range entries {
		if e.IsDir {
			folders = append(folders, e.Name)
		}
	}
	folderList := strings.Join(folders, ", ")
	if folderList == "" {
		folderList = "(none yet)"
	}

	promptTmpl := v.getFilingPrompt(settings)
	prompt := strings.Replace(promptTmpl, "{folder_list}", folderList, 1)
	prompt = strings.Replace(prompt, "{version}", versionStr, 1)
	prompt = strings.Replace(prompt, "{focus_count}", focusCountStr, 1)
	prompt = strings.Replace(prompt, "{content}", content, 1)

	respText, err := RunCLI(settings.CLI, prompt, settings.CLITimeout)
	if err != nil {
		return nil, err
	}

	// Extract JSON purely defensively (sometimes LLMs ignore instructions and wrap in markdown)
	jsonBlock := extractJSONFallback(respText)

	var rec FilingRecommendation
	if err := json.Unmarshal([]byte(jsonBlock), &rec); err != nil {
		return nil, fmt.Errorf("could not parse AI json response: %v\nJSON was: %s", err, jsonBlock)
	}

	// Backfill missing critical arrays with empty defaults avoiding nulls
	if rec.Tags == nil {
		rec.Tags = []string{}
	}

	return &rec, nil
}

// getExplainPrompt retrieves the explain prompt template from disk or falls back to
// the baked-in default.
func (v *Vault) getExplainPrompt(settings Settings) string {
	if settings.Prompts.Explain != "" {
		b, err := os.ReadFile(filepath.Join(v.Root, settings.Prompts.Explain))
		if err == nil && len(b) > 0 {
			return string(b)
		}
	}
	return DefaultExplainPrompt
}

// getAskPrompt retrieves the ask prompt template from disk or falls back to the
// baked-in default.
func (v *Vault) getAskPrompt(settings Settings) string {
	if settings.Prompts.Ask != "" {
		b, err := os.ReadFile(filepath.Join(v.Root, settings.Prompts.Ask))
		if err == nil && len(b) > 0 {
			return string(b)
		}
	}
	return DefaultAskPrompt
}

// RunExplain asks the CLI to explain the given content and returns the response
// as a markdown string for inline insertion. Returns an error in dumb mode or on
// CLI failure / timeout.
func (v *Vault) RunExplain(content string, settings Settings) (string, error) {
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}

	contentType := detectContentType(content)
	prompt := v.getExplainPrompt(settings)
	prompt = strings.Replace(prompt, "{type}", contentType, 1)
	prompt = strings.Replace(prompt, "{content}", content, 1)

	return RunCLI(settings.CLI, prompt, settings.CLITimeout)
}

// RunAsk asks the CLI a question with the given content as context. history may
// be empty for first-turn asks. Returns the response as a markdown string.
func (v *Vault) RunAsk(content, history, question string, settings Settings) (string, error) {
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}

	contentType := detectContentType(content)
	prompt := v.getAskPrompt(settings)
	prompt = strings.Replace(prompt, "{type}", contentType, 1)
	prompt = strings.Replace(prompt, "{content}", content, 1)
	prompt = strings.Replace(prompt, "{history}", history, 1)
	prompt = strings.Replace(prompt, "{question}", question, 1)

	return RunCLI(settings.CLI, prompt, settings.CLITimeout)
}

// detectContentType returns a simple content type label for use in prompts.
func detectContentType(content string) string {
	trimmed := strings.TrimSpace(content)
	if strings.HasPrefix(trimmed, "```") {
		// Fenced code block — extract language from first line
		firstLine := strings.SplitN(trimmed, "\n", 2)[0]
		lang := strings.TrimPrefix(firstLine, "```")
		lang = strings.TrimSpace(lang)
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

// RefineLanguage asks the configured CLI to identify the programming language of a
// code snippet. Returns the lowercase language name or an empty string if the CLI
// returns something unrecognised or if the call fails.
func RefineLanguage(content string, settings Settings) (string, error) {
	prompt := "Identify the programming language of this code snippet.\n" +
		"Reply with ONLY the lowercase language name (e.g. python, go, javascript, typescript, rust, java, c, cpp, sql, bash, yaml, json, xml, html, css, ruby, php, swift, kotlin, dart).\n" +
		"If you cannot identify a specific language confidently, reply with exactly: text\n\n" +
		"Code:\n" + content

	resp, err := RunCLI(settings.CLI, prompt, settings.CLITimeout)
	if err != nil {
		return "", err
	}

	// Take only the first word to strip any accidental explanation text
	lang := strings.ToLower(strings.TrimSpace(resp))
	if fields := strings.Fields(lang); len(fields) > 0 {
		lang = fields[0]
	}
	lang = strings.Trim(lang, ".,;:'\"")

	known := map[string]bool{
		"python": true, "go": true, "javascript": true, "typescript": true,
		"rust": true, "java": true, "c": true, "cpp": true, "sql": true,
		"bash": true, "sh": true, "shell": true, "yaml": true, "json": true,
		"xml": true, "html": true, "css": true, "ruby": true, "php": true,
		"swift": true, "kotlin": true, "dart": true, "text": true,
	}
	if known[lang] {
		return lang, nil
	}
	return "", nil
}

// extractJSONFallback attempts to find a JSON object in the text if it's wrapped
// in markdown or conversational chatter.
func extractJSONFallback(text string) string {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "{") && strings.HasSuffix(text, "}") {
		return text // Already raw valid json
	}

	// Hunt for fenced JSON blocks
	re := regexp.MustCompile(`(?s)\x60\x60\x60(?:json)?\s*(\{.*?\})\s*\x60\x60\x60`)
	matches := re.FindStringSubmatch(text)
	if len(matches) > 1 {
		return matches[1]
	}

	// Desperate heuristic for the first `{` to the last `}`
	first := strings.Index(text, "{")
	last := strings.LastIndex(text, "}")
	if first >= 0 && last >= 0 && last > first {
		return text[first : last+1]
	}

	return text
}
