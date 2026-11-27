package ai

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// timeoutFor reads only settings.PromptTimeouts and settings.CLITimeoutLong, so a
// zero-value AIService is sufficient to exercise the fallback logic.
func TestAIService_timeoutFor(t *testing.T) {
	s := &AIService{}

	settings := domain.Settings{
		CLITimeoutLong: 60,
		PromptTimeouts: map[string]int{
			"file": 120,
			"zero": 0, // explicit zero ⇒ treated as no override
		},
	}

	cases := []struct {
		name   string
		prompt string
		want   int
	}{
		{"override wins", "file", 120},
		{"absent falls back to global", "explain", 60},
		{"zero override falls back to global", "zero", 60},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := s.timeoutFor(settings, c.prompt); got != c.want {
				t.Errorf("timeoutFor(%q) = %d, want %d", c.prompt, got, c.want)
			}
		})
	}

	// Nil map must not panic and always falls back.
	if got := s.timeoutFor(domain.Settings{CLITimeoutLong: 42}, "file"); got != 42 {
		t.Errorf("timeoutFor with nil map = %d, want 42", got)
	}
}

// stubNodeResolver records the address it was asked about and answers with node,
// or with ErrNodeNotFound when node has no Path.
type stubNodeResolver struct {
	asked domain.Address
	node  domain.NodeDescriptor
}

func (s *stubNodeResolver) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	s.asked = addr
	if s.node.Path == "" {
		return domain.NodeDescriptor{}, domain.ErrNodeNotFound
	}
	return s.node, nil
}

// DescribeImage finds the image through the resolver alone: the src is resolved
// against the block's own document, the resolver names the file, and the CLI runs
// in that file's directory. A src the resolver cannot find is an error.
func TestAIService_DescribeImage_resolvesTheSrcThroughTheResolver(t *testing.T) {
	const (
		here  = "0197b1f4-5a5a-7000-8000-00000000c001"
		other = "0197b1f4-5a5a-7000-8000-00000000c002"
	)
	cases := []struct {
		name      string
		src       string
		node      domain.NodeDescriptor
		wantAsked domain.Address
		wantErr   bool
	}{
		{"a sieve URI names this document's asset", "sieve://" + here + "/shot.png",
			domain.NodeDescriptor{Kind: "asset", Path: "notes/here/shot.png"}, domain.NewLeafAddress(here, "shot.png"), false},
		{"a sieve URI names another document's asset", "sieve://" + other + "/shot.png",
			domain.NodeDescriptor{Kind: "asset", Path: "notes/other/shot.png"}, domain.NewLeafAddress(other, "shot.png"), false},
		{"a resolver miss is an error", "sieve://" + here + "/gone.png",
			domain.NodeDescriptor{}, domain.NewLeafAddress(here, "gone.png"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: `{"alt":"Alt","summary":"Summary"}`}
			svc := newSmartTestService(t, cap)
			resolver := &stubNodeResolver{node: tc.node}
			svc.nodes = resolver

			desc, err := svc.DescribeImage(here, tc.src, "blk-1")
			if !resolver.asked.Equal(tc.wantAsked) {
				t.Errorf("resolver asked about %v, want %v", resolver.asked, tc.wantAsked)
			}
			if tc.wantErr {
				if err == nil {
					t.Fatalf("DescribeImage succeeded (%+v), want an error", desc)
				}
				if cap.op != "" {
					t.Errorf("the CLI ran (%q) for an image that was not found", cap.op)
				}
				return
			}
			if err != nil {
				t.Fatalf("DescribeImage: %v", err)
			}
			if desc.Alt != "Alt" || desc.Summary != "Summary" {
				t.Errorf("desc = %+v", desc)
			}
			if want := filepath.Dir(filepath.Join(svc.storePath, tc.node.Path)); cap.cwd != want {
				t.Errorf("cwd = %q, want the resolved file's directory %q", cap.cwd, want)
			}
		})
	}
}

// fakeDocMCPEndpoint issues "tok-doc-{container}" for a scoped run and records
// the last exchange it was asked for and the runs ended; written is how many
// answer elements EndRun reports for the last token issued.
type fakeDocMCPEndpoint struct {
	url     string
	lastDoc string
	lastEx  domain.Exchange
	written int
	ended   []string
}

func (f *fakeDocMCPEndpoint) EndpointFor(ex domain.Exchange) (string, string) {
	f.lastDoc, f.lastEx = ex.Container, ex
	return f.url, "tok-doc-" + ex.Container
}

func (f *fakeDocMCPEndpoint) EndRun(token string) int {
	f.ended = append(f.ended, token)
	if token != "tok-doc-"+f.lastDoc {
		return 0
	}
	return f.written
}

// RunAsk, RunExplain and RunBtw bind the run's MCP token to the exchange they answer,
// end the run once the CLI has exited however it ended, and report whether the
// model wrote the answer through it; the final message is returned either way,
// and the response log is told it was discarded when the answer was written.
func TestAIService_AnsweringRuns_BindTheExchangeAndReportAWrittenAnswer(t *testing.T) {
	ex := domain.Exchange{Container: "0197b1f4-5a5a-7000-8000-00000000e001", Block: "0197b1f4-5a5a-7000-8000-00000000e002"}
	held := domain.Exchange{Container: ex.Container, Block: "0197b1f4-5a5a-7000-8000-00000000e003", Holder: domain.HeldByCommand}
	for _, tc := range []struct {
		name    string
		run     func(*AIService) (Answer, error)
		written int
		fails   error
		noted   string
		ex      domain.Exchange
	}{
		{"ask, never written", func(s *AIService) (Answer, error) { return s.RunAsk("c", "", "q", ex) }, 0, nil, "", ex},
		{"ask, written", func(s *AIService) (Answer, error) { return s.RunAsk("c", "", "q", ex) }, 2, nil,
			"discarded: the answer was written with add_to_answer (2 blocks)", ex},
		{"explain, written", func(s *AIService) (Answer, error) { return s.RunExplain("c", "", "q", ex) }, 1, nil,
			"discarded: the answer was written with add_to_answer (1 block)", ex},
		{"ask, the CLI fails", func(s *AIService) (Answer, error) { return s.RunAsk("c", "", "q", ex) }, 1, errors.New("cli timeout after 60 seconds"), "", ex},
		{"a popup command, never written", func(s *AIService) (Answer, error) { return s.RunBtw("q", "", "", "", held) }, 0, nil, "", held},
		{"a popup command, written", func(s *AIService) (Answer, error) { return s.RunBtw("q", "", "", "", held) }, 3, nil,
			"discarded: the answer was written with add_to_answer (3 blocks)", held},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: "the final message", err: tc.fails}
			svc := newSmartTestService(t, cap)
			mcpEp := &fakeDocMCPEndpoint{url: "http://127.0.0.1:41234/mcp", written: tc.written}
			svc.SetMCPEndpoint(mcpEp)

			got, err := tc.run(svc)
			if fmt.Sprint(mcpEp.ended) != fmt.Sprint([]string{"tok-doc-" + ex.Container}) {
				t.Errorf("runs ended = %q, want the run's own token, once", mcpEp.ended)
			}
			if cap.noted != tc.noted {
				t.Errorf("the response log was told %q, want %q", cap.noted, tc.noted)
			}
			if tc.fails != nil {
				if err == nil {
					t.Fatalf("run succeeded, want %v", tc.fails)
				}
				return
			}
			if err != nil {
				t.Fatalf("run: %v", err)
			}
			if want := (Answer{Text: "the final message", Written: tc.written > 0}); got != want {
				t.Errorf("answer = %+v, want %+v", got, want)
			}
			if mcpEp.lastEx != tc.ex {
				t.Errorf("token bound to %+v, want %+v", mcpEp.lastEx, tc.ex)
			}
			args := buildBaseArgs(cap.dialect, cap.model, cap.prompt, cap.profile, cap.cwd, cap.libraryDir)
			if cfg := flagValue(args, "--mcp-config"); !strings.Contains(cfg, "Bearer tok-doc-"+ex.Container) {
				t.Errorf("--mcp-config missing the exchange's bearer token: %s", cfg)
			}
		})
	}
}

// Every CLI run is issued a token of its own, bound to what it works on, and
// ends it once the CLI has exited, whether or not the run answers anything.
func TestAIService_EveryRunEndsItsToken(t *testing.T) {
	const doc = "0197b1f4-5a5a-7000-8000-00000000f001"
	page := domain.NewLeafAddress(doc, "page-1.png")
	ex := domain.Exchange{Container: doc, Block: "0197b1f4-5a5a-7000-8000-00000000f002"}
	for _, tc := range []struct {
		op    string
		run   func(*AIService) error
		bound domain.Exchange
	}{
		{"ask", func(s *AIService) error { _, err := s.RunAsk("c", "", "q", ex); return err }, ex},
		{"btw", func(s *AIService) error { _, err := s.RunBtw("q", "", "", "", ex); return err }, ex},
		{"image", func(s *AIService) error { _, err := s.DescribeImage(doc, page.String(), "b"); return err }, domain.Exchange{Container: doc}},
		{"note-meta", func(s *AIService) error { _, err := s.DescribeNote(doc, []domain.Address{page}); return err }, domain.Exchange{Container: doc}},
		{"page-transcript", func(s *AIService) error { _, err := s.TranscribePage(doc, page); return err }, domain.Exchange{Container: doc}},
		{"refine", func(s *AIService) error { _, err := s.RefineLanguage("x := 1", "", ""); return err }, domain.Exchange{}},
		{"file", func(s *AIService) error {
			note, err := s.documents.New()
			if err != nil {
				return err
			}
			_, err = s.EvaluateBuffer(note.Meta(), []byte("body"))
			return err
		}, domain.Exchange{}},
		{"web-clip-fetch", func(s *AIService) error {
			_, _, err := s.RunWebClip(doc, "w", "https://example.com", "fetch", "")
			return err
		}, domain.Exchange{Container: doc}},
	} {
		t.Run(tc.op, func(t *testing.T) {
			cap := &captureRunner{ret: "{}"}
			svc := newSmartTestService(t, cap)
			svc.nodes = pathResolver{page.String(): "blocks/" + doc + "/page-1.png"}
			ds, err := services.NewDocumentService(svc.state.Store())
			if err != nil {
				t.Fatalf("NewDocumentService: %v", err)
			}
			svc.documents = ds
			mcpEp := &fakeDocMCPEndpoint{url: "http://127.0.0.1:41234/mcp"}
			svc.SetMCPEndpoint(mcpEp)

			if err := tc.run(svc); err != nil {
				t.Fatalf("%s: %v", tc.op, err)
			}
			if cap.op != tc.op || mcpEp.lastEx != tc.bound {
				t.Errorf("ran %q bound to %+v, want %q bound to %+v", cap.op, mcpEp.lastEx, tc.op, tc.bound)
			}
			if want := []string{"tok-doc-" + tc.bound.Container}; fmt.Sprint(mcpEp.ended) != fmt.Sprint(want) {
				t.Errorf("runs ended = %q, want the run's own token, once", mcpEp.ended)
			}
		})
	}
}

func TestAIService_RunWebClip_PromptAssemblyAndDocScopedProfile(t *testing.T) {
	cap := &captureRunner{ret: "# Suzuka Schedule\n\nGates open at 08:00."}
	svc := newSmartTestService(t, cap)
	fs, err := filestore.NewFileStore(svc.storePath, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	svc.documents = ds
	mcpEp := &fakeDocMCPEndpoint{url: "http://127.0.0.1:41234/mcp"}
	svc.SetMCPEndpoint(mcpEp)

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New doc: %v", err)
	}
	doc.SetBody([]byte("# My Trip Notes"))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save doc: %v", err)
	}
	uuid := doc.UUID()
	sourceURL := "https://example.com/suzuka"

	for _, mode := range []string{"fetch", "summarise"} {
		t.Run(mode, func(t *testing.T) {
			title, content, err := svc.RunWebClip(uuid, "wc-1", sourceURL, mode, "# My Trip Notes")
			if err != nil {
				t.Fatalf("RunWebClip(%s): %v", mode, err)
			}
			if title != "Suzuka Schedule" || !strings.Contains(content, "Gates open at 08:00.") {
				t.Errorf("got title=%q content=%q", title, content)
			}
			if mcpEp.lastDoc != uuid {
				t.Errorf("EndpointFor called with %q, want %q", mcpEp.lastDoc, uuid)
			}
			template, _ := svc.prompts.GetPromptContent("web-clip-" + mode)
			want := strings.ReplaceAll(strings.ReplaceAll(template, "{source}", sourceURL), "{document}", "# My Trip Notes")
			if cap.prompt != want {
				t.Errorf("mode %s prompt = %q, want the filled template %q", mode, cap.prompt, want)
			}
			args := buildBaseArgs(cap.dialect, cap.model, cap.prompt, cap.profile, cap.cwd, cap.libraryDir)
			if cfg := flagValue(args, "--mcp-config"); !strings.Contains(cfg, "Bearer tok-doc-"+uuid) {
				t.Errorf("--mcp-config missing document-scoped bearer token: %s", cfg)
			}
			if allow := flagValue(args, "--allowedTools"); !strings.Contains(allow, "mcp__sieve__*") {
				t.Errorf("--allowedTools missing mcp__sieve__*: %s", allow)
			}
		})
	}
}

// pathResolver names each asset address's file by the path it is given for it.
type pathResolver map[string]string

func (r pathResolver) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	if path, ok := r[addr.String()]; ok {
		return domain.NodeDescriptor{Kind: "asset", Path: path}, nil
	}
	return domain.NodeDescriptor{}, domain.ErrNodeNotFound
}

// DescribeNote runs in the directory of the note's page images, names them in page order, offers
// the library's top-level folders as the categories, uses the note's own containment profile, and
// reads the model's JSON bare or fenced. Images in two directories, none at all, or a dumb tier
// are errors, and the CLI does not run.
func TestAIService_DescribeNote_ShowsThePagesAndReadsTheAnswer(t *testing.T) {
	const note = "0197b1f4-5a5a-7000-8000-00000000d001"
	answer := `{"title": "Kitchen extension planning", "keywords": ["extension", "budget, rough"], "categories": ["Home"], "summary": "Plans."}`
	first, second := domain.NewLeafAddress(note, "page-b-2.png"), domain.NewLeafAddress(note, "page-a-1.png")
	resolver := pathResolver{
		first.String():  "blocks/" + note + "/page-b-2.png",
		second.String(): "blocks/" + note + "/page-a-1.png",
		domain.NewLeafAddress(note, "stray.png").String(): "elsewhere/stray.png",
	}
	for _, tc := range []struct {
		name    string
		reply   string
		pages   []domain.Address
		dumb    bool
		wantErr bool
	}{
		{"a bare answer", answer, []domain.Address{first, second}, false, false},
		{"a fenced answer", "```json\n" + answer + "\n```", []domain.Address{first, second}, false, false},
		{"pages in two directories", answer, []domain.Address{first, domain.NewLeafAddress(note, "stray.png")}, false, true},
		{"no pages", answer, nil, false, true},
		{"a dumb tier", answer, []domain.Address{first, second}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: tc.reply}
			svc := newSmartTestService(t, cap)
			svc.nodes = resolver
			ds, err := services.NewDocumentService(svc.state.Store())
			if err != nil {
				t.Fatal(err)
			}
			svc.documents = ds
			for _, folder := range []string{"Home", "Work"} {
				if _, err := svc.state.Store().CreateOrLoadFolder(domain.LibraryCategory, folder); err != nil {
					t.Fatal(err)
				}
			}
			if tc.dumb {
				settings := svc.state.LoadSettings()
				settings.CLI, settings.CLIPath = "", ""
				if err := svc.state.SaveSettings(settings); err != nil {
					t.Fatal(err)
				}
			}
			mcpEp := &fakeDocMCPEndpoint{url: "http://127.0.0.1:41234/mcp"}
			svc.SetMCPEndpoint(mcpEp)

			got, err := svc.DescribeNote(note, tc.pages)
			if tc.wantErr {
				if err == nil || cap.op != "" {
					t.Fatalf("DescribeNote = %+v, %v; the CLI ran %q", got, err, cap.op)
				}
				return
			}
			if err != nil {
				t.Fatalf("DescribeNote: %v", err)
			}
			want := domain.NoteMetadata{Title: "Kitchen extension planning", Keywords: []string{"extension", "budget, rough"},
				Categories: []string{"Home"}, Summary: "Plans."}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("DescribeNote = %+v", got)
			}
			if cap.op != "note-meta" || cap.cwd != filepath.Join(svc.storePath, "blocks", note) || mcpEp.lastDoc != note {
				t.Errorf("op %q, cwd %q, profile for %q", cap.op, cap.cwd, mcpEp.lastDoc)
			}
			template, _ := svc.prompts.GetPromptContent("note-meta")
			wantPrompt := strings.NewReplacer("{page_files}", "1. page-b-2.png\n2. page-a-1.png", "{category_list}", "Home, Work").Replace(template)
			if cap.prompt != wantPrompt {
				t.Errorf("prompt = %q, want %q", cap.prompt, wantPrompt)
			}
		})
	}
}

// TranscribePage runs in the directory of the page's image, names it to the model, uses the note's own
// containment profile, and parses the model's parts bare or fenced, text and both diagram
// languages alike. A page image that is no asset, or a dumb tier, is an error, and the CLI does
// not run.
func TestAIService_TranscribePage_ShowsThePageAndParsesItsParts(t *testing.T) {
	const note = "0197b1f4-5a5a-7000-8000-00000000d002"
	answer := `{"parts": [{"type": "text", "markdown": "# Kitchen\n\n- tiles [?]"},` +
		`{"type": "diagram", "language": "mermaid", "source": "flowchart TD\n  A --> B"},` +
		`{"type": "diagram", "language": "plantuml", "source": "Alice -> Bob: hi"}]}`
	image := domain.NewLeafAddress(note, "page-p1-k1.png")
	resolver := pathResolver{image.String(): "blocks/" + note + "/page-p1-k1.png"}
	want := domain.PageTranscript{Parts: []domain.TranscriptPart{
		{Type: domain.TranscriptPartText, Markdown: "# Kitchen\n\n- tiles [?]"},
		{Type: domain.TranscriptPartDiagram, Language: "mermaid", Source: "flowchart TD\n  A --> B"},
		{Type: domain.TranscriptPartDiagram, Language: "plantuml", Source: "Alice -> Bob: hi"},
	}}
	for _, tc := range []struct {
		name    string
		reply   string
		page    domain.Address
		dumb    bool
		wantErr bool
	}{
		{"a bare answer", answer, image, false, false},
		{"a fenced answer", "```json\n" + answer + "\n```", image, false, false},
		{"a page that is no asset", answer, domain.NewLeafAddress(note, "missing.png"), false, true},
		{"a dumb tier", answer, image, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: tc.reply}
			svc := newSmartTestService(t, cap)
			svc.nodes = resolver
			if tc.dumb {
				settings := svc.state.LoadSettings()
				settings.CLI, settings.CLIPath = "", ""
				if err := svc.state.SaveSettings(settings); err != nil {
					t.Fatal(err)
				}
			}
			mcpEp := &fakeDocMCPEndpoint{url: "http://127.0.0.1:41234/mcp"}
			svc.SetMCPEndpoint(mcpEp)

			got, err := svc.TranscribePage(note, tc.page)
			if tc.wantErr {
				if err == nil || cap.op != "" {
					t.Fatalf("TranscribePage = %+v, %v; the CLI ran %q", got, err, cap.op)
				}
				return
			}
			if err != nil {
				t.Fatalf("TranscribePage: %v", err)
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("TranscribePage = %+v", got)
			}
			if cap.op != "page-transcript" || cap.cwd != filepath.Join(svc.storePath, "blocks", note) || mcpEp.lastDoc != note {
				t.Errorf("op %q, cwd %q, profile for %q", cap.op, cap.cwd, mcpEp.lastDoc)
			}
			template, _ := svc.prompts.GetPromptContent("page-transcript")
			if wantPrompt := strings.ReplaceAll(template, "{page_file}", "page-p1-k1.png"); cap.prompt != wantPrompt {
				t.Errorf("prompt = %q, want %q", cap.prompt, wantPrompt)
			}
		})
	}
}
