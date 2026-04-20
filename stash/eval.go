package stash

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"stash/logger"
)

// FilingRecommendation mirrors the expected JSON structure from the AI.
type FilingRecommendation struct {
	Keep             bool     `json:"keep"`
	Title            string   `json:"title"`
	Filename         string   `json:"filename"`
	Folder           string   `json:"folder"`
	NewFolder        bool     `json:"new_folder"`
	Type             string   `json:"type"`
	Summary          string   `json:"summary"`
	Tags             []string `json:"tags"`
	AiJustification  string   `json:"ai_justification"`
	DensitySignals   []string `json:"density_signals"`
}

func (v *Store) getFilingPrompt(settings Settings) string {
	p, _ := GetPromptContent("file", settings)
	return p
}

// EvaluateBuffer executes the AI evaluation over a buffer on disk and returns the
// unmarshaled recommendation.
func (v *Store) EvaluateBuffer(path string, settings Settings) (*FilingRecommendation, error) {
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

	// Read existing top-level folders in store/
	var folders []string
	if infos, err := os.ReadDir(v.NotesPath()); err == nil {
		for _, info := range infos {
			if info.IsDir() && !strings.HasPrefix(info.Name(), ".") {
				folders = append(folders, info.Name())
			}
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

	respText, err := RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeout, filepath.Dir(path))
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
	if rec.DensitySignals == nil {
		rec.DensitySignals = []string{}
	}

	return &rec, nil
}

func (v *Store) getExplainPrompt(settings Settings) string {
	p, _ := GetPromptContent("explain", settings)
	return p
}

func (v *Store) getAskPrompt(settings Settings) string {
	p, _ := GetPromptContent("ask", settings)
	return p
}

// RunExplain asks the CLI to explain the given content and returns the response
// as a markdown string for inline insertion. noteCwd is the directory of the note
// file being explained — sets the CLI's working directory so relative asset paths
// in the content resolve correctly. Pass "" to inherit the process working directory.
func (v *Store) RunExplain(content, history string, settings Settings, noteCwd string, imagePaths []string) (string, error) {
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}

	contentType := detectContentType(content)
	prompt := v.getExplainPrompt(settings)
	prompt = strings.Replace(prompt, "{type}", contentType, 1)
	prompt = strings.Replace(prompt, "{history}", history, 1)
	prompt = strings.Replace(prompt, "{content}", content, 1)

	imageNames := []string{}
	for _, p := range imagePaths {
		rel, err := filepath.Rel(noteCwd, p)
		if err == nil {
			imageNames = append(imageNames, rel)
		} else {
			imageNames = append(imageNames, filepath.Base(p))
		}
	}
	replacement := "N/A"
	if len(imageNames) > 0 {
		replacement = strings.Join(imageNames, ", ")
	}

	prompt = strings.Replace(prompt, "{images}", replacement, 1)

	if len(imagePaths) > 0 {
		return RunCLIWithImages(settings.CLI, prompt, imagePaths, settings.Model, settings.CLITimeoutLong, noteCwd)
	}
	return RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// RunAsk asks the CLI a question with the given content as context. history may be
// empty for first-turn asks. noteCwd is the directory of the note/buffer file —
// sets the CLI's working directory so relative asset paths resolve correctly.
func (v *Store) RunAsk(content, history, question string, settings Settings, noteCwd string, imagePaths []string) (string, error) {
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}

	contentType := detectContentType(content)
	prompt := v.getAskPrompt(settings)
	prompt = strings.Replace(prompt, "{type}", contentType, 1)
	prompt = strings.Replace(prompt, "{content}", content, 1)
	prompt = strings.Replace(prompt, "{history}", history, 1)
	prompt = strings.Replace(prompt, "{question}", question, 1)
	imageNames := []string{}
	for _, p := range imagePaths {
		rel, err := filepath.Rel(noteCwd, p)
		if err == nil {
			imageNames = append(imageNames, rel)
		} else {
			imageNames = append(imageNames, filepath.Base(p))
		}
	}
	replacement := "N/A"
	if len(imageNames) > 0 {
		replacement = strings.Join(imageNames, ", ")
	}

	prompt = strings.Replace(prompt, "{images}", replacement, 1)

	if len(imagePaths) > 0 {
		logger.Info("has Images")
		return RunCLIWithImages(settings.CLI, prompt, imagePaths, settings.Model, settings.CLITimeoutLong, noteCwd)
	}
	logger.Info("has ZERO Images")
	return RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong, noteCwd)
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

	resp, err := RunCLI(settings.CLI, prompt, settings.Model, 10, "")
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

// ImageDesc is the structured response from DescribeImage.
type ImageDesc struct {
	Filename string `json:"filename"`
	Alt      string `json:"alt"`
	Summary  string `json:"summary"`
}

// DescribeImage sends an image to the configured CLI and returns alt text, a
// summary, and a suggested filename. imagePath must be an absolute filesystem path.
// The CLI's working directory is set to the image's directory so relative paths
// in the prompt resolve correctly.
//
// For Claude/Copilot: explicit --image flags carry the binary.
// For Gemini: no --image flag exists; instead the image is base64-encoded and
// appended to the prompt body so the model receives it as inline multimodal data
// rather than via its file-reading tools (which fail against the Code Assist API).
func DescribeImage(imagePath string, settings Settings) (ImageDesc, error) {
	promptTmpl, _ := GetPromptContent("image", settings)
	filename := filepath.Base(imagePath)
	prompt := strings.Replace(promptTmpl, "{image_filename}", filename, 1)
	cwd := filepath.Dir(imagePath)

	resp, err := RunCLIWithImages(settings.CLI, prompt, []string{imagePath}, settings.Model, 15, cwd)
	if err != nil {
		return ImageDesc{}, err
	}

	cleaned := extractJSONFallback(resp)
	var desc ImageDesc
	if err := json.Unmarshal([]byte(cleaned), &desc); err != nil {
		return ImageDesc{}, fmt.Errorf("parse image desc: %w", err)
	}
	return desc, nil
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
