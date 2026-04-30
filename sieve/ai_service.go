package sieve

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sieve/logger"
)

// AIService owns all AI evaluation and filing operations. It resolves prompt
// templates, settings, and folder lists internally so callers need no boilerplate.
type AIService struct {
	state     *StateService
	prompts   *PromptService
	buffers   *BufferService
	notes     *NoteService
	storePath string
}

func NewAIService(state *StateService, prompts *PromptService, buffers *BufferService, notes *NoteService, storePath string) *AIService {
	return &AIService{state: state, prompts: prompts, buffers: buffers, notes: notes, storePath: storePath}
}

// EvaluateAndFileDoc runs the full evaluate-and-file pipeline for the document
// at path. fileAfter promotes a buffer to the Library (or refiles a note).
// allowDiscard permits deletion of empty bodies and trash-intent documents.
func (s *AIService) EvaluateAndFileDoc(path string, fileAfter, allowDiscard bool) (FilingOutcome, error) {
	b, n, isNote, err := filingLoadDoc(path, s.buffers, s.notes)
	if err != nil {
		return FilingOutcome{}, err
	}

	var meta DocumentMeta
	var body []byte
	if isNote {
		meta, body = n.Meta(), n.Body()
	} else {
		meta, body = b.Meta(), b.Body()
	}

	userIntent := ""
	if ui := meta.UserIntent(); ui != nil {
		userIntent = *ui
	}

	if fileAfter && isHTMLBodyEmpty(string(body)) && userIntent != "keep" {
		return FilingOutcome{Discarded: true}, filingDiscardDoc(isNote, b, n, s.buffers, s.notes)
	}

	if userIntent == "trash" {
		if allowDiscard {
			return FilingOutcome{Discarded: true}, filingDiscardDoc(isNote, b, n, s.buffers, s.notes)
		}
		return filingCommitDoc(isNote, b, n, s.buffers, s.notes, false, false)
	}

	settings := s.state.LoadSettings()
	evaluated := false
	if settings.Tier() != TierDumb {
		rec, err := s.runEvaluateBuffer(meta, body, settings)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: eval %s: %w", path, err)
		}
		s.applyFilingRec(meta, rec, settings.CLI)
		evaluated = true
	}

	return filingCommitDoc(isNote, b, n, s.buffers, s.notes, evaluated, fileAfter)
}

// EvaluateBuffer runs the AI evaluation over a loaded document and returns the
// filing recommendation. The caller provides meta and body from an already-loaded
// document; folders, settings, and the prompt template are resolved internally.
func (s *AIService) EvaluateBuffer(meta DocumentMeta, body []byte) (*FilingRecommendation, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return nil, fmt.Errorf("AI evaluation not available in Dumb mode")
	}
	return s.runEvaluateBuffer(meta, body, settings)
}

// RunExplain asks the AI to explain the given content and returns a markdown
// response. notePath is store-relative (or absolute); imageStorePaths are
// store-relative paths to attached image assets.
func (s *AIService) RunExplain(content, history, notePath string, imageStorePaths []string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("explain")
	noteCwd := filepath.Dir(s.resolvePath(notePath))
	imagePaths := s.absImagePaths(imageStorePaths)

	contentType := detectContentType(content)
	p := strings.ReplaceAll(prompt, "{type}", contentType)
	p = strings.ReplaceAll(p, "{history}", history)
	p = strings.ReplaceAll(p, "{content}", content)
	p = strings.ReplaceAll(p, "{images}", imageNameList(imagePaths, noteCwd))

	if len(imagePaths) > 0 {
		return RunCLIWithImages(settings.CLI, p, imagePaths, settings.Model, settings.CLITimeoutLong, noteCwd)
	}
	return RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// RunAsk asks the AI a question with the given content as context. history may
// be empty for first-turn asks. notePath and imageStorePaths follow the same
// conventions as RunExplain.
func (s *AIService) RunAsk(content, history, question, notePath string, imageStorePaths []string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("ask")
	noteCwd := filepath.Dir(s.resolvePath(notePath))
	imagePaths := s.absImagePaths(imageStorePaths)

	contentType := detectContentType(content)
	p := strings.ReplaceAll(prompt, "{type}", contentType)
	p = strings.ReplaceAll(p, "{content}", content)
	p = strings.ReplaceAll(p, "{history}", history)
	p = strings.ReplaceAll(p, "{question}", question)
	p = strings.ReplaceAll(p, "{images}", imageNameList(imagePaths, noteCwd))

	if len(imagePaths) > 0 {
		logger.Info("RunAsk: has images", "count", len(imagePaths))
		return RunCLIWithImages(settings.CLI, p, imagePaths, settings.Model, settings.CLITimeoutLong, noteCwd)
	}
	return RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// DescribeImage sends an image to the configured AI and returns alt text, a
// summary, and a suggested filename. storeRelPath is relative to the store root.
func (s *AIService) DescribeImage(storeRelPath string) (ImageDesc, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return ImageDesc{}, fmt.Errorf("dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("image")
	imagePath := filepath.Join(s.storePath, storeRelPath)

	data, err := os.ReadFile(imagePath)
	if err == nil {
		if strings.Contains(string(data), "<svg") || strings.Contains(string(data), "<SVG") || strings.Contains(string(data), "<?xml") {
			logger.Info("DescribeImage bypassed for SVG", "path", imagePath)
			return ImageDesc{Filename: filepath.Base(imagePath), Detect: "Unsupported SVG"}, nil
		}
	}

	p := strings.ReplaceAll(prompt, "{image_filename}", filepath.Base(imagePath))
	cwd := filepath.Dir(imagePath)
	resp, err := RunCLIWithImages(settings.CLI, p, []string{imagePath}, settings.Model, settings.CLITimeoutLong, cwd)
	if err != nil {
		return ImageDesc{}, err
	}

	cleaned := extractJSONFallback(resp)
	var desc ImageDesc
	if err := json.Unmarshal([]byte(cleaned), &desc); err != nil {
		return ImageDesc{}, fmt.Errorf("parse image desc: %w", err)
	}
	desc.Detect = "ai"
	return desc, nil
}

// RefineLanguage asks the AI to identify the programming language of a code
// snippet. Returns the lowercase language name or empty string.
func (s *AIService) RefineLanguage(content string) (string, error) {
	settings := s.state.LoadSettings()
	prompt, _ := s.prompts.GetPromptContent("refine")
	p := strings.ReplaceAll(prompt, "{content}", content)

	resp, err := RunCLI(settings.CLI, p, settings.Model, settings.CLITimeout, "")
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

// ── Private helpers ───────────────────────────────────────────────────────────

func (s *AIService) runEvaluateBuffer(meta DocumentMeta, body []byte, settings Settings) (*FilingRecommendation, error) {
	prompt, _ := s.prompts.GetPromptContent("file")
	folders := s.libraryFolders()

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

	p := strings.ReplaceAll(prompt, "{folder_list}", folderList)
	p = strings.ReplaceAll(p, "{version}", versionStr)
	p = strings.ReplaceAll(p, "{focus_count}", focusCountStr)
	p = strings.ReplaceAll(p, "{created}", createdStr)
	p = strings.ReplaceAll(p, "{modified}", modifiedStr)
	p = strings.ReplaceAll(p, "{now}", time.Now().Format(time.RFC3339))
	p = strings.ReplaceAll(p, "{content}", string(body))

	respText, err := RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, "")
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

func (s *AIService) applyFilingRec(meta DocumentMeta, rec *FilingRecommendation, cli string) {
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
		s2 := rec.Summary
		meta.SetSummary(&s2)
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

func (s *AIService) libraryFolders() []string {
	entries, _ := s.notes.List()
	var folders []string
	for _, e := range entries {
		if e.IsDir {
			folders = append(folders, e.Name)
		}
	}
	return folders
}

func (s *AIService) resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	if s.storePath != "" {
		return filepath.Join(s.storePath, path)
	}
	return path
}

func (s *AIService) absImagePaths(storePaths []string) []string {
	abs := make([]string, len(storePaths))
	for i, p := range storePaths {
		abs[i] = filepath.Join(s.storePath, p)
	}
	return abs
}
