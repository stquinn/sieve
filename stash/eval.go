package stash

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"stash/logger"
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

// EvaluateBuffer executes the AI evaluation over a document and returns the
// unmarshaled filing recommendation. meta and body come from the Store-loaded
// document; folders is the current list of top-level Library folder names;
// promptOverride is the already-loaded prompt template (empty = use default).
func EvaluateBuffer(meta DocumentMeta, body []byte, folders []string, settings Settings, promptTmpl string) (*FilingRecommendation, error) {
	if settings.Tier() == TierDumb {
		return nil, fmt.Errorf("AI evaluation not available in Dumb mode")
	}

	versionStr := fmt.Sprintf("%d", meta.Version())
	if versionStr == "0" {
		versionStr = "1"
	}
	focusCountStr := fmt.Sprintf("%d", meta.FocusCount())

	createdStr := "unknown"
	if c := meta.Created(); !c.IsZero() {
		createdStr = c.Format("2006-01-02T15:04:05")
	}
	modifiedStr := "unknown"
	if m := meta.Modified(); !m.IsZero() {
		modifiedStr = m.Format("2006-01-02T15:04:05")
	}

	folderList := strings.Join(folders, ", ")
	if folderList == "" {
		folderList = "(none yet)"
	}

	prompt := strings.ReplaceAll(promptTmpl, "{folder_list}", folderList)
	prompt = strings.ReplaceAll(prompt, "{version}", versionStr)
	prompt = strings.ReplaceAll(prompt, "{focus_count}", focusCountStr)
	prompt = strings.ReplaceAll(prompt, "{created}", createdStr)
	prompt = strings.ReplaceAll(prompt, "{modified}", modifiedStr)
	prompt = strings.ReplaceAll(prompt, "{now}", time.Now().Format(time.RFC3339))
	prompt = strings.ReplaceAll(prompt, "{content}", string(body))

	respText, err := RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong, "")
	if err != nil {
		return nil, err
	}

	jsonBlock := extractJSONFallback(respText)

	var rec FilingRecommendation
	if err := json.Unmarshal([]byte(jsonBlock), &rec); err != nil {
		return nil, fmt.Errorf("could not parse AI json response: %v\nJSON was: %s", err, jsonBlock)
	}

	if rec.Tags == nil {
		rec.Tags = []string{}
	}
	if rec.DensitySignals == nil {
		rec.DensitySignals = []string{}
	}

	return &rec, nil
}

// RunExplain asks the CLI to explain the given content and returns the response
// as a markdown string for inline insertion. noteCwd is the directory of the
// note file — sets the CLI's working directory so relative asset paths resolve
// correctly. Pass "" to inherit the process working directory.
// promptOverride is the already-loaded prompt template (empty = use default).
func RunExplain(content, history string, settings Settings, noteCwd string, imagePaths []string, promptTmpl string) (string, error) {
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}

	contentType := detectContentType(content)
	prompt := strings.ReplaceAll(promptTmpl, "{type}", contentType)
	prompt = strings.ReplaceAll(prompt, "{history}", history)
	prompt = strings.ReplaceAll(prompt, "{content}", content)
	prompt = strings.ReplaceAll(prompt, "{images}", imageNameList(imagePaths, noteCwd))

	if len(imagePaths) > 0 {
		return RunCLIWithImages(settings.CLI, prompt, imagePaths, settings.Model, settings.CLITimeoutLong, noteCwd)
	}
	return RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// RunAsk asks the CLI a question with the given content as context. history may
// be empty for first-turn asks. noteCwd is the directory of the note/buffer
// file — sets the CLI's working directory so relative asset paths resolve.
// promptOverride is the already-loaded prompt template (empty = use default).
func RunAsk(content, history, question string, settings Settings, noteCwd string, imagePaths []string, promptTmpl string) (string, error) {
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}

	contentType := detectContentType(content)
	prompt := strings.ReplaceAll(promptTmpl, "{type}", contentType)
	prompt = strings.ReplaceAll(prompt, "{content}", content)
	prompt = strings.ReplaceAll(prompt, "{history}", history)
	prompt = strings.ReplaceAll(prompt, "{question}", question)
	prompt = strings.ReplaceAll(prompt, "{images}", imageNameList(imagePaths, noteCwd))

	if len(imagePaths) > 0 {
		logger.Info("RunAsk: has images", "count", len(imagePaths))
		return RunCLIWithImages(settings.CLI, prompt, imagePaths, settings.Model, settings.CLITimeoutLong, noteCwd)
	}
	return RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// ImageDesc is the structured response from DescribeImage.
type ImageDesc struct {
	Filename string `json:"filename"`
	Alt      string `json:"alt"`
	Summary  string `json:"summary"`
}

// DescribeImage sends an image to the configured CLI and returns alt text, a
// summary, and a suggested filename. imagePath must be an absolute filesystem path.
// promptOverride is the already-loaded prompt template (empty = use default).
func DescribeImage(imagePath string, settings Settings, promptTmpl string) (ImageDesc, error) {
	prompt := strings.ReplaceAll(promptTmpl, "{image_filename}", filepath.Base(imagePath))
	cwd := filepath.Dir(imagePath)

	resp, err := RunCLIWithImages(settings.CLI, prompt, []string{imagePath}, settings.Model, settings.CLITimeoutLong, cwd)
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

// RefineLanguage asks the configured CLI to identify the programming language of
// a code snippet. Returns the lowercase language name or empty string.
// promptOverride is the already-loaded prompt template (empty = use default).
func RefineLanguage(content string, settings Settings, promptTmpl string) (string, error) {
	prompt := strings.ReplaceAll(promptTmpl, "{content}", content)

	resp, err := RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeout, "")
	if err != nil {
		return "", err
	}

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

// ApplyFilingRec applies a FilingRecommendation to DocumentMeta in place.
// Only non-empty recommendation fields overwrite existing meta values; the
// eval status and timestamp are always updated.
func ApplyFilingRec(meta DocumentMeta, rec *FilingRecommendation, cli string) {
	now := time.Now().Format("2006-01-02T15:04:05")
	meta.SetAiEval("complete")
	meta.SetAiLastEvaluated(&now)
	keep := rec.Keep
	meta.SetAiKeep(&keep)
	if cli != "" {
		meta.SetCLI(&cli)
	}
	if rec.Title != "" {
		meta.SetDisplayName(rec.Title)
	}
	if rec.Filename != "" {
		fn := rec.Filename
		meta.SetFilename(&fn)
	}
	if rec.Folder != "" {
		folder := rec.Folder
		meta.SetAiFolderSuggestion(&folder)
	}
	if rec.Summary != "" {
		s := rec.Summary
		meta.SetSummary(&s)
	}
	if len(rec.Tags) > 0 {
		meta.SetTags(rec.Tags)
	}
	if rec.AiJustification != "" {
		j := rec.AiJustification
		meta.SetAiJustification(&j)
	}
	if len(rec.DensitySignals) > 0 {
		meta.SetDensitySignals(rec.DensitySignals)
	}
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
	// Remove markdown code fences if present.
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
