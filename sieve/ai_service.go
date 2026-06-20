package sieve

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"

	"golang.org/x/net/html"
)

// AIService owns all AI evaluation and filing operations. It resolves prompt
// templates, settings, and folder lists internally so callers need no boilerplate.
type AIService struct {
	state     *StateService
	prompts   *PromptService
	documents *DocumentService
	storePath string
}

func NewAIService(state *StateService, prompts *PromptService, documents *DocumentService, storePath string) *AIService {
	return &AIService{state: state, prompts: prompts, documents: documents, storePath: storePath}
}

// EvaluateAndFileDoc runs the full evaluate-and-file pipeline for the document
// at path. fileAfter promotes a buffer to the LibraryCategory (or refiles a note).
// allowDiscard permits deletion of empty bodies and trash-intent documents.
func (s *AIService) EvaluateAndFileDoc(id string, fileAfter bool, allowDiscard bool) (FilingOutcome, error) {
	doc, err := s.documents.LoadByUUID(id)
	if err != nil {
		return FilingOutcome{}, err
	}

	meta := doc.Meta()
	body := doc.Body()

	userIntent := ""
	if ui := meta.UserIntent(); ui != nil {
		userIntent = *ui
	}

	if isHTMLBodyEmpty(string(body)) {
		if fileAfter && allowDiscard && userIntent != "keep" {
			return FilingOutcome{Discarded: true}, s.documents.Delete(doc)
		}
		return FilingOutcome{Discarded: false}, nil
	}

	if userIntent == "trash" {
		if allowDiscard {
			return FilingOutcome{Discarded: true}, s.documents.Delete(doc)
		}
	}

	settings := s.state.LoadSettings()
	evaluated := false
	if settings.Tier() != domain.TierDumb {
		rec, err := s.runEvaluateBuffer(meta, body, settings)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: eval %s: %w", doc.Storable().ExternalRef(), err)
		}
		doc, err = s.documents.UpdateAiMetadata(doc, rec, settings.CLI)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: update meta %s: %w", doc.Storable().ExternalRef(), err)
		}
		evaluated = true
	}

	return filingCommitDocument(doc, s.documents, evaluated || userIntent == "keep", fileAfter)
}

// EvaluateBuffer runs the AI evaluation over a loaded document and returns the
// filing recommendation. The caller provides meta and body from an already-loaded
// document; folders, settings, and the prompt template are resolved internally.
func (s *AIService) EvaluateBuffer(meta domain.DocumentMeta, body []byte) (*domain.FilingRecommendation, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return nil, fmt.Errorf("AI evaluation not available in Dumb mode")
	}
	return s.runEvaluateBuffer(meta, body, settings)
}

// RunExplain asks the AI to explain the given content and returns a markdown
// response. noteUUID identifies the owning document (used to resolve the working
// directory for the CLI process). imageStorePaths are store-relative image paths.
func (s *AIService) RunExplain(content, history, question, noteUUID string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("explain")
	noteCwd := filepath.Dir(s.resolvePath(s.resolveNotePath(noteUUID)))

	contentType := detectContentType(content)
	p := strings.ReplaceAll(prompt, "{type}", contentType)
	p = strings.ReplaceAll(p, "{content}", content)
	p = strings.ReplaceAll(p, "{history}", history)
	p = strings.ReplaceAll(p, "{action}", question)

	return RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// RunAsk asks the AI a question with the given content as context. history may
// be empty for first-turn asks. noteUUID and imageStorePaths follow the same
// conventions as RunExplain.
func (s *AIService) RunAsk(content, history, question, noteUUID string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("ask")
	noteCwd := filepath.Dir(s.resolvePath(s.resolveNotePath(noteUUID)))

	contentType := detectContentType(content)
	p := strings.ReplaceAll(prompt, "{type}", contentType)
	p = strings.ReplaceAll(p, "{content}", content)
	p = strings.ReplaceAll(p, "{history}", history)
	p = strings.ReplaceAll(p, "{action}", question)

	return RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// DescribeImage sends an image to the configured AI and returns alt text, a
// summary, and a suggested filename. storeRelPath is relative to the store root.
func (s *AIService) DescribeImage(uuid string, storeRelPath string, blkId string) (domain.ImageDesc, error) {
	logger.Info("Describe uuid: " + uuid)
	logger.Info("Describe storeRelPath: " + storeRelPath)
	logger.Info("Describe blkId: " + blkId)
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return domain.ImageDesc{}, fmt.Errorf("dumb mode")
	}
	doc, err := s.documents.LoadByUUID(uuid)
	if err != nil {
		return domain.ImageDesc{}, err
	}
	docDir := filepath.Join(s.storePath, doc.Storable().ExternalRef())

	var imagePath string
	for _, assetItr := range doc.Storable().Owns() {
		as, ok := assetItr.(store.AssetStorable)
		if ok && as.BlkID() == blkId {
			imagePath = filepath.Join(docDir, as.Key())
			break
		}
	}
	if imagePath == "" {
		// Asset attachment may have been overwritten by a later flush.
		// Fall back to constructing the path from storeRelPath (= asset.ExternalRef()).
		candidate := filepath.Join(docDir, storeRelPath)
		if _, statErr := os.Stat(candidate); statErr != nil {
			logger.Warn("DescribeImage: asset not found", "blkId", blkId, "src", storeRelPath, "candidate", candidate)
			return domain.ImageDesc{}, fmt.Errorf("image file not found for block %s", blkId)
		}
		logger.Info("DescribeImage: asset attachment missing, using path fallback", "path", candidate)
		imagePath = candidate
	}

	prompt, _ := s.prompts.GetPromptContent("image")
	logger.Info("About to Describe", "path", imagePath)
	p := strings.ReplaceAll(prompt, "{image_filename}", filepath.Base(imagePath))
	cwd := filepath.Dir(imagePath)
	resp, err := RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, cwd)
	if err != nil {
		return domain.ImageDesc{}, err
	}

	cleaned := extractJSONFallback(resp)
	var desc domain.ImageDesc
	if err := json.Unmarshal([]byte(cleaned), &desc); err != nil {
		return domain.ImageDesc{}, fmt.Errorf("parse image desc: %w", err)
	}
	desc.Detect = "ai"
	return desc, nil
}

// RefineLanguage asks the AI to identify the programming language of a code
// snippet. Returns the lowercase language name or empty string.
func (s *AIService) RefineLanguage(content, currentLanguage, detectionMethod string) (string, error) {
	settings := s.state.LoadSettings()
	prompt, _ := s.prompts.GetPromptContent("refine")
	p := strings.ReplaceAll(prompt, "{content}", content)
	p = strings.ReplaceAll(p, "{current_language}", currentLanguage)
	p = strings.ReplaceAll(p, "{detection_method}", detectionMethod)

	resp, err := RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, "")
	if err != nil {
		return "", err
	}

	lang := strings.ToLower(strings.TrimSpace(resp))
	if fields := strings.Fields(lang); len(fields) > 0 {
		lang = fields[0]
	}
	lang = strings.Trim(lang, ".,;:'\"")

	if canonical, ok := block.CanonicalLanguages[lang]; ok {
		lang = canonical
	}

	if block.KnownLanguages[lang] {
		return lang, nil
	}
	return "", nil
}

// DetectCodeLanguage returns the programming language for source code.
// It tries heuristics first (fast, no AI call). If heuristics are not
// confident, RefineLanguage is called. Returns "unknown" on failure.
func (s *AIService) DetectCodeLanguage(source, hint string) (string, error) {
	if lang, ok := block.DetectByHeuristics(source, hint); ok {
		return lang, nil
	}
	lang, err := s.RefineLanguage(source, "", "")
	if err != nil {
		return "unknown", err
	}
	if lang == "" {
		return "unknown", nil
	}
	return lang, nil
}

// GetLinkTitle fetches the HTML <title> of a URL. Returns empty string (not an
// error) when the page has no title or returns a non-200 status.
func (s *AIService) GetLinkTitle(targetURL string) (string, error) {
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 10 * time.Second,
	}
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil
	}
	doc, err := html.Parse(resp.Body)
	if err != nil {
		return "", err
	}
	var title string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if title != "" {
			return
		}
		if n.Type == html.ElementNode && n.Data == "title" && n.FirstChild != nil {
			title = n.FirstChild.Data
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return strings.TrimSpace(title), nil
}

// ── Private helpers ───────────────────────────────────────────────────────────

func (s *AIService) runEvaluateBuffer(meta domain.DocumentMeta, body []byte, settings domain.Settings) (*domain.FilingRecommendation, error) {
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
	var rec domain.FilingRecommendation
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

// applyFilingRec is deprecated, logic moved to DocumentService.UpdateAiMetadata

func (s *AIService) libraryFolders() []string {
	entries, _ := s.documents.List()
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

// resolveNotePath looks up a document by UUID and returns its store-relative
// path, used to derive the CLI working directory. Returns empty string if the
// UUID is empty or the document cannot be found.
func (s *AIService) resolveNotePath(uuid string) string {
	if uuid == "" || s.documents == nil {
		return ""
	}
	doc, err := s.documents.LoadByUUID(uuid)
	if err != nil {
		return ""
	}
	return doc.Storable().ExternalRef()
}

// FilingOutcome is the result of AIService.EvaluateAndFileDoc.
// Exactly one of Note or Buffer is non-nil when Discarded is false.
type FilingOutcome struct {
	Discarded bool
	Document  domain.Document
}

func filingCommitDocument(n domain.Document, documents *DocumentService, save bool, fileAfter bool) (FilingOutcome, error) {
	if save {
		var err error
		if fileAfter {
			// Refresh the body from disk before a full save so that concurrent
			// body writes (e.g. an in-flight explain inserting a PENDING block)
			// are not overwritten by stale body data read at evaluation start.
			if fresh, loadErr := documents.LoadByUUID(n.UUID()); loadErr == nil {
				n.SetBody(fresh.Body())
			}
			n, err = documents.Save(n)
		} else {
			// If just saving metadata (e.g. evaluation results), don't bump version
			n, err = documents.SaveMeta(n)
		}
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: save note: %w", err)
		}
	}
	if fileAfter {
		refiled, err := documents.File(n)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: refile: %w", err)
		}
		return FilingOutcome{Document: refiled}, nil
	}
	return FilingOutcome{Document: n}, nil
}

// isHTMLBodyEmpty returns true if html contains no visible text content —
// only tags, whitespace, and self-closing elements. Used to detect blank
// buffers before discarding them without involving the AI.
func isHTMLBodyEmpty(html string) bool {
	inTag := false
	for _, r := range html {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag && r != ' ' && r != '\t' && r != '\n' && r != '\r':
			return false
		}
	}
	return true
}

// ── Web Clip ──────────────────────────────────────────────────────────────────

// extractFirstHeading returns the text of the first ATX heading in content,
// or empty string if none found.
func extractFirstHeading(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "# "))
		}
	}
	return ""
}

// RunWebClip retrieves a URL via the configured CLI using the overridable prompt
// for the given mode ("web-clip-fetch" or "web-clip-summarise"), runs image
// localisation on the result, and returns (title, content, error).
// docContent is the current document body (used by Summarise mode for context).
func (s *AIService) RunWebClip(uuid, id, source, mode, docContent string) (title, content string, err error) {
	settings := s.state.LoadSettings()

	promptName := "web-clip-fetch"
	if mode == "summarise" {
		promptName = "web-clip-summarise"
	}
	promptTemplate, _ := s.prompts.GetPromptContent(promptName)
	prompt := strings.ReplaceAll(promptTemplate, "{source}", source)
	prompt = strings.ReplaceAll(prompt, "{document}", docContent)

	doc, loadErr := s.documents.LoadByUUID(uuid)
	cwd := ""
	docDir := ""
	if loadErr == nil {
		cwd = filepath.Join(s.storePath, filepath.Dir(doc.Storable().ExternalRef()))
		docDir = filepath.Join(s.storePath, doc.Storable().ExternalRef())
	}

	raw, err := RunCLI(settings.CLI, prompt, settings.Model, settings.CLITimeoutLong, cwd)
	if err != nil {
		return "", "", err
	}

	content = localiseImages(raw, docDir, uuid)
	title = extractFirstHeading(content)
	if title == "" {
		if t, err2 := s.GetLinkTitle(source); err2 == nil {
			title = t
		}
	}
	return title, content, nil
}
