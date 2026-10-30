package ai

import (
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

type fakeDocMCPEndpoint struct {
	url     string
	lastDoc string
}

func (f *fakeDocMCPEndpoint) Endpoint() (string, string) {
	return f.url, "tok-unscoped"
}

func (f *fakeDocMCPEndpoint) EndpointForDoc(docUUID string) (string, string) {
	f.lastDoc = docUUID
	return f.url, "tok-doc-" + docUUID
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
				t.Errorf("EndpointForDoc called with %q, want %q", mcpEp.lastDoc, uuid)
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
