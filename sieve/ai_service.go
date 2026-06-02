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

	"golang.org/x/net/html"
	"sieve/logger"
	"sieve/sieve/aiblock"
	"sieve/store"
	"sieve/sieve/webclip"
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
// at path. fileAfter promotes a buffer to the Library (or refiles a note).
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
	if settings.Tier() != TierDumb {
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
func (s *AIService) EvaluateBuffer(meta DocumentMeta, body []byte) (*FilingRecommendation, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return nil, fmt.Errorf("AI evaluation not available in Dumb mode")
	}
	return s.runEvaluateBuffer(meta, body, settings)
}

// RunExplain asks the AI to explain the given content and returns a markdown
// response. noteUUID identifies the owning document (used to resolve the working
// directory for the CLI process). imageStorePaths are store-relative image paths.
func (s *AIService) RunExplain(content, history, noteUUID string, imageBlockIds []string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("explain")
	imagePaths, noteCwd := s.resolveAIImages(noteUUID, imageBlockIds)
	if noteCwd == "" {
		noteCwd = filepath.Dir(s.resolvePath(s.resolveNotePath(noteUUID)))
	}

	contentType := detectContentType(content)
	p := strings.ReplaceAll(prompt, "{type}", contentType)
	p = strings.ReplaceAll(p, "{history}", history)
	p = strings.ReplaceAll(p, "{content}", content)
	p = strings.ReplaceAll(p, "{images}", imageNameList(imagePaths, noteCwd))

	return RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// RunAsk asks the AI a question with the given content as context. history may
// be empty for first-turn asks. noteUUID and imageStorePaths follow the same
// conventions as RunExplain.
func (s *AIService) RunAsk(content, history, question, noteUUID string, imageBlockIds []string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("ask")
	imagePaths, noteCwd := s.resolveAIImages(noteUUID, imageBlockIds)
	if noteCwd == "" {
		noteCwd = filepath.Dir(s.resolvePath(s.resolveNotePath(noteUUID)))
	}

	contentType := detectContentType(content)
	p := strings.ReplaceAll(prompt, "{type}", contentType)
	p = strings.ReplaceAll(p, "{content}", content)
	p = strings.ReplaceAll(p, "{history}", history)
	p = strings.ReplaceAll(p, "{question}", question)
	p = strings.ReplaceAll(p, "{images}", imageNameList(imagePaths, noteCwd))

	if len(imagePaths) > 0 {
		logger.Info("RunAsk: has images", "count", len(imagePaths))
	}
	return RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, noteCwd)
}

// ResolveAiBlock finds the block with blkId in noteUUID's body, sets it to
// COMPLETE with the given response and model, and saves the document.
func (s *AIService) ResolveAiBlock(noteUUID, blkId, response, model, blockType string) error {
	doc, err := s.documents.LoadByUUID(noteUUID)
	if err != nil {
		return fmt.Errorf("ResolveAiBlock: load %s: %w", noteUUID, err)
	}
	body := string(doc.Body())
	blocks := aiblock.ParseAll(body)
	var found aiblock.AiBlockData
	for _, b := range blocks {
		if b.ID == blkId {
			found = b
			break
		}
	}
	if found.ID == "" {
		return fmt.Errorf("ResolveAiBlock: block %q not found in %s", blkId, noteUUID)
	}
	if model == "" {
		model = s.state.LoadSettings().Model
	}
	found.Status = "COMPLETE"
	found.Response = response
	found.Model = model
	if blockType != "" {
		found.Type = blockType
	}
	found.CompletedAt = time.Now().UTC().Format(time.RFC3339)

	newBody, err := aiblock.Replace(body, found)
	if err != nil {
		return fmt.Errorf("ResolveAiBlock: replace: %w", err)
	}
	doc.SetBody([]byte(newBody))
	_, err = s.documents.Save(doc)
	return err
}

// DescribeImage sends an image to the configured AI and returns alt text, a
// summary, and a suggested filename. storeRelPath is relative to the store root.
func (s *AIService) DescribeImage(uuid string, storeRelPath string, blkId string) (ImageDesc, error) {
	logger.Info("Describe uuid: " + uuid)
	logger.Info("Describe storeRelPath: " + storeRelPath)
	logger.Info("Describe blkId: " + blkId)
	settings := s.state.LoadSettings()
	if settings.Tier() == TierDumb {
		return ImageDesc{}, fmt.Errorf("dumb mode")
	}
	doc, err := s.documents.LoadByUUID(uuid)
	if err != nil {
		return ImageDesc{}, err
	}
	var asset store.AssetStorable
	for _, assetItr := range doc.Storable().Owns() {
		as, ok := assetItr.(store.AssetStorable)
		if ok && as.BlkID() == blkId {
			asset = as
			break
		}
	}
	if asset == nil {
		return ImageDesc{}, err
	}
	prompt, _ := s.prompts.GetPromptContent("image")
	imagePath := filepath.Join(s.storePath, doc.Storable().ExternalRef(), asset.Key())
	logger.Info("About to Doc ExtRef " + doc.Storable().ExternalRef())
	logger.Info("About to Asset Key " + asset.Key())
	logger.Info("About to Asset ExtRef " + asset.ExternalRef())
	logger.Info("About to Describe " + imagePath)
	data, err := os.ReadFile(imagePath)
	if err == nil {
		if strings.Contains(string(data), "<svg") || strings.Contains(string(data), "<SVG") || strings.Contains(string(data), "<?xml") {
			logger.Info("DescribeImage bypassed for SVG", "path", imagePath)
			return ImageDesc{Filename: filepath.Base(imagePath), Detect: "Unsupported SVG"}, nil
		}
	}

	p := strings.ReplaceAll(prompt, "{image_filename}", filepath.Base(imagePath))
	cwd := filepath.Dir(imagePath)
	resp, err := RunCLI(settings.CLI, p, settings.Model, settings.CLITimeoutLong, cwd)
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

// DetectCodeLanguage returns the programming language for source code.
// It tries heuristics first (fast, no AI call). If heuristics are not
// confident, RefineLanguage is called. Returns "unknown" on failure.
func (s *AIService) DetectCodeLanguage(source, hint string) (string, error) {
	if lang, ok := detectByHeuristics(source, hint); ok {
		return lang, nil
	}
	lang, err := s.RefineLanguage(source)
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

// resolveAIImages loads the document by noteUUID, derives the note's working
// directory, and returns absolute paths for any owned assets whose blk-id
// (filename without extension) appears in blockIds. noteCwd is always returned
// when the document loads, regardless of whether any images matched.
func (s *AIService) resolveAIImages(noteUUID string, blockIds []string) (imagePaths []string, noteCwd string) {
	if noteUUID == "" || s.documents == nil {
		return nil, ""
	}
	doc, err := s.documents.LoadByUUID(noteUUID)
	if err != nil {
		return nil, ""
	}
	noteCwd = filepath.Join(s.storePath, doc.Storable().ExternalRef())
	if len(blockIds) == 0 {
		return nil, noteCwd
	}
	idSet := make(map[string]bool, len(blockIds))
	for _, id := range blockIds {
		idSet[id] = true
	}
	for _, owned := range doc.Storable().Owns() {
		as, ok := owned.(store.AssetStorable)
		if !ok {
			continue
		}
		if idSet[as.BlkID()] {
			imagePaths = append(imagePaths, filepath.Join(noteCwd, as.Key()))
		}
	}
	return
}

// FilingOutcome is the result of AIService.EvaluateAndFileDoc.
// Exactly one of Note or Buffer is non-nil when Discarded is false.
type FilingOutcome struct {
	Discarded bool
	Document  Document
}

func filingCommitDocument(n Document, documents *DocumentService, save bool, fileAfter bool) (FilingOutcome, error) {
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

// ResolveWebClip finds the web-clip block with id in uuid's document body,
// updates its fields to the given status/content/etc., and saves the document.
func (s *AIService) ResolveWebClip(uuid, id, title, content, model, errMsg, status, completedAt string) error {
	doc, err := s.documents.LoadByUUID(uuid)
	if err != nil {
		return fmt.Errorf("ResolveWebClip: load %s: %w", uuid, err)
	}
	body := string(doc.Body())
	blocks := webclip.ParseAll(body)

	var found webclip.WebClipData
	for _, b := range blocks {
		if b.ID == id {
			found = b
			break
		}
	}
	if found.ID == "" {
		return fmt.Errorf("ResolveWebClip: block %q not found in %s", id, uuid)
	}

	found.Status = status
	if title != "" {
		found.Title = title
	}
	if content != "" {
		found.Content = content
	}
	if model != "" {
		found.Model = model
	}
	if errMsg != "" {
		found.Error = errMsg
	}
	if completedAt != "" {
		found.CompletedAt = completedAt
	}

	newBody, err := webclip.Replace(body, found)
	if err != nil {
		return fmt.Errorf("ResolveWebClip: replace: %w", err)
	}
	doc.SetBody([]byte(newBody))
	_, err = s.documents.Save(doc)
	return err
}
