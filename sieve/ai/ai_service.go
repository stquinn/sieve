package ai

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
	lheur "sieve/sieve/lang"
	"sieve/sieve/services"

	"golang.org/x/net/html"
)

// MCPEndpoint issues the runtime URL and a per-run bearer token for the
// internal Sieve MCP server, and ends a run. EndpointFor binds the token to an
// exchange: verbs that write into a document (such as fetch_page) touch only
// its container, and an answer written through the MCP lands only in its block;
// an empty Exchange grants neither. writes says whether the run may call the
// write verbs at all, a run that may not being refused every one and named only
// the read verbs; verbs are the names of the verbs the run may call. An
// empty URL means no server is reachable, so the profile renders without MCP
// flags. EndRun ends the run holding token once its CLI has exited, however it
// ended: the token is refused from then on, and EndRun returns how many
// elements of the exchange's answer the run wrote. The internal MCP server
// satisfies it.
type MCPEndpoint interface {
	EndpointFor(ex domain.Exchange, writes bool) (url, token string, verbs []string)
	EndRun(token string) (written int)
}

// Answer is what an answering run produced — an Ask, an Explain or a popup
// command: the CLI's final message, and whether the model wrote its answer into
// the exchange through the MCP. When it
// did, the written elements are the answer and Text is not shown.
type Answer struct {
	Text    string
	Written bool
}

// AIService owns all AI evaluation and filing operations. It resolves prompt
// templates, settings, and folder lists internally so callers need no boilerplate.
type AIService struct {
	state     *services.StateService
	prompts   *PromptService
	documents *services.DocumentService
	nodes     domain.NodeResolver // dereferences an image block's src to its asset file
	storePath string
	runner    CLIRunner   // exec seam; stubbable in tests
	mcp       MCPEndpoint // internal Sieve MCP endpoint; nil until wired
}

func NewAIService(state *services.StateService, prompts *PromptService, documents *services.DocumentService, nodes domain.NodeResolver, storePath string) *AIService {
	return &AIService{
		state:     state,
		prompts:   prompts,
		documents: documents,
		nodes:     nodes,
		storePath: storePath,
		runner:    execCLIRunner{},
	}
}

// SetMCPEndpoint wires the internal Sieve MCP endpoint. Once set, every AI call's
// containment profile carries the live server URL + a bearer token issued for
// that run in its builtin MCP grant, so the contained CLI can query the
// knowledge base.
func (s *AIService) SetMCPEndpoint(e MCPEndpoint) { s.mcp = e }

// SetRunner overrides the CLI execution seam.
func (s *AIService) SetRunner(r CLIRunner) { s.runner = r }

// profileFor returns the containment floor for a CLI call scoped to ex, and the
// bearer token it carries ("" when no MCP is reachable): the builtin Sieve MCP
// grant's runtime URL, a token bound to ex and the verbs the run may call are
// filled in when an endpoint is wired and reachable; writes says whether those
// include the write verbs. When none is, the builtin grant keeps its empty URL
// and the backend renders no MCP flags.
func (s *AIService) profileFor(ex domain.Exchange, writes bool) (domain.ContainmentProfile, string) {
	p := s.savedProfile()
	if s.mcp == nil {
		return p, ""
	}
	url, token, verbs := s.mcp.EndpointFor(ex, writes)
	if url == "" {
		return p, ""
	}
	// LoadSettings returns a cached Settings whose McpServers slice is shared —
	// copy it before filling the builtin's runtime URL + per-call bearer so the
	// secret never leaks into the cache (or a later serialisation).
	servers := make([]domain.McpGrant, len(p.McpServers))
	copy(servers, p.McpServers)
	for i := range servers {
		if servers[i].Builtin {
			servers[i].URL = url
			servers[i].Token = token
			servers[i].Verbs = verbs
		}
	}
	p.McpServers = servers
	return p, token
}

// run runs the CLI once for the task named name with data, in cwd, under the
// containment floor with its MCP token bound to ex and its Sieve verbs those
// the task's output allows. Its prompt is built once the run's backend has said
// whether it carries the Sieve tools. Every CLI run takes this path: the token
// is issued for the run alone and ended once the CLI has exited, however it
// exited, and the response log is told when the final message was discarded
// for a written answer. The Answer says whether the model wrote ex's answer
// through the MCP.
func (s *AIService) run(settings domain.Settings, name string, data TaskData, cwd string, ex domain.Exchange) (Answer, error) {
	task, err := s.prompts.Task(name)
	if err != nil {
		return Answer{}, err
	}
	binary, dialect := settings.ResolveCLI()
	profile, token := s.profileFor(ex, task.Writes())
	held := s.runOf(token)
	run := Run{
		Task:       task,
		CLI:        CLI{Binary: binary, Dialect: dialect, Model: settings.Model, TimeoutSecs: s.timeoutFor(settings, name)},
		Profile:    profile,
		Cwd:        cwd,
		LibraryDir: s.storePath,
	}
	run.Prompt = s.prompts.Prompt(task, data, run.carriesSieveTools())
	text, err := s.runner.Run(run, held.responseNote)
	written := held.end()
	if err != nil {
		return Answer{}, err
	}
	return Answer{Text: text, Written: written > 0}, nil
}

// mcpRun is a run's hold on its MCP token. It ends once: when the response log
// asks what became of the final message, or when the CLI exited without one;
// from then on it knows how many elements of its exchange's answer the run
// wrote.
type mcpRun struct {
	mcp     MCPEndpoint // nil when the run holds no token
	token   string
	once    sync.Once
	written int
}

// runOf is the run holding token, a token profileFor issued.
func (s *AIService) runOf(token string) *mcpRun {
	if token == "" {
		return &mcpRun{}
	}
	return &mcpRun{mcp: s.mcp, token: token}
}

// end ends the run on its first call and returns how many answer elements it wrote.
func (r *mcpRun) end() int {
	r.once.Do(func() {
		if r.mcp != nil {
			r.written = r.mcp.EndRun(r.token)
		}
	})
	return r.written
}

// responseNote ends the run and says, when it wrote its answer with the tool,
// that its final message is discarded. A ResponseNote.
func (r *mcpRun) responseNote() string {
	switch n := r.end(); n {
	case 0:
		return ""
	case 1:
		return "discarded: the answer was written with add_to_answer (1 block)"
	default:
		return fmt.Sprintf("discarded: the answer was written with add_to_answer (%d blocks)", n)
	}
}

// savedProfile is the user's SAVED profile (baseline + their additions), which
// ParseSettings reconstitutes as the full in-memory profile — NOT a bare
// DefaultContainmentProfile(), which would silently drop every user grant
// (added tools/dirs/MCP servers) from the AI call. It carries no runtime state,
// so unlike profile() it costs nothing and mints nothing.
func (s *AIService) savedProfile() domain.ContainmentProfile {
	p := s.state.LoadSettings().AI.Containment
	if len(p.Tools) == 0 && len(p.Directories) == 0 && len(p.McpServers) == 0 {
		return domain.DefaultContainmentProfile() // defensive: never render an empty profile
	}
	return p
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

	if s.isHTMLBodyEmpty(string(body)) {
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

	return s.filingCommitDocument(doc, evaluated || userIntent == "keep", fileAfter)
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

// RunExplain asks the AI to explain the given content for the exchange ex. The
// CLI runs in the directory of ex's container, and its MCP grant is bound to ex,
// so the model may write its answer into ex's block.
func (s *AIService) RunExplain(content, history, question string, ex domain.Exchange) (Answer, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return Answer{}, fmt.Errorf("explain not available in dumb mode")
	}
	data := ThreadData{ContentType: s.detectContentType(content), Content: content, History: history, Action: question}
	return s.run(settings, "explain", data, s.noteDir(ex.Container), ex)
}

// RunAsk asks the AI a question with the given content as context. history may
// be empty for first-turn asks. ex follows the same conventions as RunExplain.
func (s *AIService) RunAsk(content, history, question string, ex domain.Exchange) (Answer, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return Answer{}, fmt.Errorf("ask not available in dumb mode")
	}
	data := ThreadData{ContentType: s.detectContentType(content), Content: content, History: history, Action: question}
	return s.run(settings, "ask", data, s.noteDir(ex.Container), ex)
}

// RunBtw answers a popup command's question for the exchange ex, the command's
// own block. The document ex.Container is pointer context only (meta strings —
// this path never touches the ShadowDoc); an empty one is the floor (no open
// tab) and falls back to the store root as cwd. The run's MCP grant is bound to
// ex, so the model may write its answer into the command's block.
func (s *AIService) RunBtw(question, selection, docTitle, docSummary string, ex domain.Exchange) (Answer, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return Answer{}, fmt.Errorf("btw not available in dumb mode")
	}
	cwd := s.storePath
	if ex.Container != "" {
		cwd = s.noteDir(ex.Container)
	}
	data := BtwData{Question: question, Selection: selection, DocTitle: docTitle, DocSummary: docSummary, DocUUID: ex.Container}
	return s.run(settings, "btw", data, cwd, ex)
}

// Tier exposes the current capability tier so AI-backed commands can fail
// fast in Build (policy in the tool, never the dispatcher). RunBtw keeps its
// own guard as defence in depth.
func (s *AIService) Tier() domain.Tier { return s.state.LoadSettings().Tier() }

// DescribeImage sends an image to the configured AI and returns alt text, a
// summary, and a suggested filename. src is the block's stored asset reference
// (sieve://{container}/{key}, or a legacy spelling ResolveAssetReference reads),
// resolved against document uuid; the image file is whatever the NodeResolver says it names.
func (s *AIService) DescribeImage(uuid string, src string, blkId string) (domain.ImageDesc, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return domain.ImageDesc{}, fmt.Errorf("dumb mode")
	}

	imagePath, err := s.assetPath(uuid, src)
	if err != nil {
		logger.Warn("DescribeImage: asset not found", "blkId", blkId, "src", src, "err", err)
		return domain.ImageDesc{}, fmt.Errorf("image file not found for block %s: %w", blkId, err)
	}

	logger.Info("About to Describe", "path", imagePath)
	resp, err := s.run(settings, "image", ImageData{File: filepath.Base(imagePath)}, filepath.Dir(imagePath), domain.Exchange{Container: uuid})
	if err != nil {
		return domain.ImageDesc{}, err
	}

	cleaned := s.extractJSONFallback(resp.Text)
	var desc domain.ImageDesc
	if err := json.Unmarshal([]byte(cleaned), &desc); err != nil {
		return domain.ImageDesc{}, fmt.Errorf("parse image desc: %w", err)
	}
	desc.Detect = "ai"
	return desc, nil
}

// DescribeNote describes the handwritten note in container uuid from images of
// its pages: pages are their absolute addresses, in page order, and must all name
// files in one directory, the CLI's working directory, which the prompt lists by
// file name. The library's top-level folders are offered as the categories to
// choose from. The answer is parsed and nothing else is checked of it.
func (s *AIService) DescribeNote(uuid string, pages []domain.Address) (domain.NoteMetadata, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return domain.NoteMetadata{}, fmt.Errorf("note description not available in dumb mode")
	}
	if len(pages) == 0 {
		return domain.NoteMetadata{}, fmt.Errorf("note %s: no page images to describe", uuid)
	}
	cwd, files := "", make([]string, 0, len(pages))
	for i, page := range pages {
		path, err := s.assetPath(uuid, page.String())
		if err != nil {
			return domain.NoteMetadata{}, fmt.Errorf("note %s: page image %s: %w", uuid, page, err)
		}
		if i == 0 {
			cwd = filepath.Dir(path)
		} else if filepath.Dir(path) != cwd {
			return domain.NoteMetadata{}, fmt.Errorf("note %s: page image %s is not beside %s", uuid, page, cwd)
		}
		files = append(files, filepath.Base(path))
	}
	data := NoteMetaData{Pages: files, Categories: s.libraryFolders()}
	resp, err := s.run(settings, "note-meta", data, cwd, domain.Exchange{Container: uuid})
	if err != nil {
		return domain.NoteMetadata{}, err
	}
	var meta domain.NoteMetadata
	if err := json.Unmarshal([]byte(s.extractJSONFallback(resp.Text)), &meta); err != nil {
		return domain.NoteMetadata{}, fmt.Errorf("parse note description: %w", err)
	}
	return meta, nil
}

// TranscribePage transcribes one page of the handwritten note in container uuid from page,
// the absolute address of an image of it, an asset of that container: the CLI
// runs in the image's directory, which the prompt names it in. The answer is
// parsed and nothing else is checked of it.
func (s *AIService) TranscribePage(uuid string, page domain.Address) (domain.PageTranscript, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return domain.PageTranscript{}, fmt.Errorf("page transcript not available in dumb mode")
	}
	path, err := s.assetPath(uuid, page.String())
	if err != nil {
		return domain.PageTranscript{}, fmt.Errorf("note %s: page image %s: %w", uuid, page, err)
	}
	resp, err := s.run(settings, "page-transcript", PageTranscriptData{File: filepath.Base(path)}, filepath.Dir(path), domain.Exchange{Container: uuid})
	if err != nil {
		return domain.PageTranscript{}, err
	}
	var transcript domain.PageTranscript
	if err := json.Unmarshal([]byte(s.extractJSONFallback(resp.Text)), &transcript); err != nil {
		return domain.PageTranscript{}, fmt.Errorf("parse page transcript: %w", err)
	}
	return transcript, nil
}

// assetPath is the absolute path of the asset file src names, read off the
// NodeDescriptor the resolver returns for it.
func (s *AIService) assetPath(uuid, src string) (string, error) {
	addr, err := domain.ResolveAssetReference(src, domain.NewContainerAddress(uuid))
	if err != nil {
		return "", err
	}
	if s.nodes == nil {
		return "", fmt.Errorf("no node resolver to find %s", addr)
	}
	node, err := s.nodes.Resolve(addr)
	if err != nil {
		return "", err
	}
	if node.Path == "" {
		return "", fmt.Errorf("%s is not an asset", addr)
	}
	return filepath.Join(s.storePath, node.Path), nil
}

// RefineLanguage asks the AI to identify the programming language of a code
// snippet. Returns the lowercase language name or empty string.
func (s *AIService) RefineLanguage(content, currentLanguage, detectionMethod string) (string, error) {
	settings := s.state.LoadSettings()
	// cwd is never unset: refine has no note context, so fall back to the library
	// root rather than the process cwd (which on a Finder/Dock-launched macOS app
	// is /). #41.
	data := RefineData{Content: content, CurrentLanguage: currentLanguage, DetectionMethod: detectionMethod}
	resp, err := s.run(settings, "refine", data, s.storePath, domain.Exchange{})
	if err != nil {
		return "", err
	}

	lang := strings.ToLower(strings.TrimSpace(resp.Text))
	if fields := strings.Fields(lang); len(fields) > 0 {
		lang = fields[0]
	}
	lang = strings.Trim(lang, ".,;:'\"")

	if canonical, ok := lheur.CanonicalLanguages[lang]; ok {
		lang = canonical
	}

	if lheur.KnownLanguages[lang] {
		return lang, nil
	}
	return "", nil
}

// DetectCodeLanguage returns the programming language for source code.
// It tries heuristics first (fast, no AI call). If heuristics are not
// confident, RefineLanguage is called. Returns "unknown" on failure.
func (s *AIService) DetectCodeLanguage(source, hint string) (string, error) {
	if lang, ok := lheur.DetectByHeuristics(source, hint); ok {
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

// timeoutFor returns the CLI timeout (seconds) for the named prompt: the
// per-prompt override in settings when set (> 0), otherwise the global
// CLITimeoutLong default.
func (s *AIService) timeoutFor(settings domain.Settings, promptName string) int {
	if t, ok := settings.PromptTimeouts[promptName]; ok && t > 0 {
		return t
	}
	return settings.CLITimeoutLong
}

func (s *AIService) runEvaluateBuffer(meta domain.DocumentMeta, body []byte, settings domain.Settings) (*domain.FilingRecommendation, error) {
	data := FilingData{
		Folders:    s.libraryFolders(),
		Now:        time.Now(),
		Created:    meta.Created(),
		Modified:   meta.Modified(),
		FocusCount: meta.FocusCount(),
		Version:    meta.Version(),
		Content:    string(body),
	}
	// cwd is never unset: the filing evaluation reads no note files, so fall back
	// to the library root rather than the process cwd (/ on a Finder-launched
	// macOS app). #41.
	resp, err := s.run(settings, "file", data, s.storePath, domain.Exchange{})
	if err != nil {
		return nil, err
	}

	jsonBlock := s.extractJSONFallback(resp.Text)
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

// noteDir returns the absolute path of the note's OWN directory — the folder
// that holds its markdown and assets (ExternalRef is that folder, not its
// parent). It is the CLI's cwd so relative asset paths in the note resolve and
// the "note" containment grant scopes to this note. Empty/unknown uuid resolves
// to the library root. (Do NOT filepath.Dir this — that lands on the category/
// buffers parent and over-scopes the note grant.)
func (s *AIService) noteDir(uuid string) string {
	return s.resolvePath(s.resolveNotePath(uuid))
}

// FilingOutcome is the result of AIService.EvaluateAndFileDoc.
// Exactly one of Note or Buffer is non-nil when Discarded is false.
type FilingOutcome struct {
	Discarded bool
	Document  domain.Document
}

func (s *AIService) filingCommitDocument(n domain.Document, save bool, fileAfter bool) (FilingOutcome, error) {
	if save {
		var err error
		if fileAfter {
			// Refresh the body from disk before a full save so that concurrent
			// body writes (e.g. an in-flight explain inserting a PENDING block)
			// are not overwritten by stale body data read at evaluation start.
			if fresh, loadErr := s.documents.LoadByUUID(n.UUID()); loadErr == nil {
				n.SetBody(fresh.Body())
			}
			n, err = s.documents.Save(n)
		} else {
			// If just saving metadata (e.g. evaluation results), don't bump version
			n, err = s.documents.SaveMeta(n)
		}
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: save note: %w", err)
		}
	}
	if fileAfter {
		refiled, err := s.documents.File(n)
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
func (s *AIService) isHTMLBodyEmpty(html string) bool {
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
func (s *AIService) extractFirstHeading(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "# "))
		}
	}
	return ""
}

// RunWebClip retrieves a URL via the configured CLI with the task for the given
// mode (web-clip-summarise for "summarise", web-clip-fetch otherwise), runs
// image localisation on the result, and returns (title, content, error).
// docContent is the current document body (the summarise task's context).
func (s *AIService) RunWebClip(uuid, id, source, mode, docContent string) (title, content string, err error) {
	settings := s.state.LoadSettings()

	taskName, data := "web-clip-fetch", TaskData(WebClipFetchData{Source: source})
	if mode == "summarise" {
		taskName, data = "web-clip-summarise", WebClipSummariseData{Source: source, Document: docContent}
	}

	var doc domain.Document
	var loadErr error
	if s.documents != nil {
		doc, loadErr = s.documents.LoadByUUID(uuid)
	}
	cwd := ""
	docDir := ""
	if loadErr == nil && doc != nil {
		// cwd is the note's OWN folder (== docDir), not its parent — same as the
		// other AI ops (see noteDir). filepath.Dir here over-scoped to the
		// category/buffers root.
		docDir = filepath.Join(s.storePath, doc.Storable().ExternalRef())
		cwd = docDir
	}

	raw, err := s.run(settings, taskName, data, cwd, domain.Exchange{Container: uuid})
	if err != nil {
		return "", "", err
	}

	content = localiseImages(raw.Text, docDir, uuid)
	title = s.extractFirstHeading(content)
	if title == "" {
		if t, err2 := s.GetLinkTitle(source); err2 == nil {
			title = t
		}
	}
	return title, content, nil
}
