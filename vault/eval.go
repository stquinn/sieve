package vault

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
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

func (v *Vault) getFilingPrompt(settings Settings) string {
	p, _ := GetPromptContent("file", settings)
	return p
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
	focusCountStr := "0"
	createdStr := "unknown"
	modifiedStr := "unknown"
	
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
			if m := regexp.MustCompile(`(?m)^created:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})`).FindStringSubmatch(metaStr); len(m) > 1 {
				createdStr = m[1]
			}
			if m := regexp.MustCompile(`(?m)^modified:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})`).FindStringSubmatch(metaStr); len(m) > 1 {
				modifiedStr = m[1]
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
	prompt = strings.Replace(prompt, "{created}", createdStr, 1)
	prompt = strings.Replace(prompt, "{modified}", modifiedStr, 1)
	prompt = strings.Replace(prompt, "{now}", time.Now().Format(time.RFC3339), 1)
	prompt = strings.Replace(prompt, "{content}", content, 1)

	respText, err := RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeout)
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

func (v *Vault) getExplainPrompt(settings Settings) string {
	p, _ := GetPromptContent("explain", settings)
	return p
}

func (v *Vault) getAskPrompt(settings Settings) string {
	p, _ := GetPromptContent("ask", settings)
	return p
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

	return RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong)
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

	return RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong)
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
	promptTmpl, _ := GetPromptContent("refine", settings)
	prompt := strings.Replace(promptTmpl, "{content}", content, 1)

	resp, err := RunCLI(settings.CLI, prompt, settings.Model, 10)
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
	
	// Remove markdown code fences if present
	text = regexp.MustCompile(`(?s)^?(\x60\x60\x60(json)?\n?)(.*?)(\n?\x60\x60\x60)?$`).ReplaceAllString(text, "$3")
	text = strings.TrimSpace(text)

	if strings.HasPrefix(text, "{") && strings.HasSuffix(text, "}") {
		return text 
	}

	// Desperate heuristic for the first `{` to the last `}`
	first := strings.Index(text, "{")
	last := strings.LastIndex(text, "}")
	if first >= 0 && last >= 0 && last > first {
		return text[first : last+1]
	}

	return text
}
