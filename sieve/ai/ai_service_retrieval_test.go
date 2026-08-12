package ai

import (
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// retrievalService builds an AIService over a temp store with the given CLI
// configured. It NEVER execs anything — the capability question is answered from
// settings and the rendered profile alone.
func retrievalService(t *testing.T, cli string, endpoint MCPEndpoint) *AIService {
	t.Helper()
	root := t.TempDir()
	fs, err := filestore.NewFileStore(root, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	settings := domain.DefaultSettings()
	settings.CLI = cli
	settings.AI.Containment = domain.LoadContainmentProfile(domain.DefaultContainmentProfile())
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	return &AIService{state: state, storePath: root, mcp: endpoint}
}

// claude and copilot both render the builtin Sieve MCP, so the model can fetch a
// document body itself — the manifest has a get_note to point at.
func TestRendersMCP_TrueForBackendsThatInjectTheBuiltinServer(t *testing.T) {
	live := fakeMCPEndpoint{url: "http://127.0.0.1:9999/mcp", token: "t"}
	for _, cli := range []string{"claude", "copilot"} {
		svc := retrievalService(t, cli, live)
		if !svc.RendersMCP() {
			t.Errorf("%s: RendersMCP = false, want true", cli)
		}
		// Proof the capability agrees with what is actually rendered.
		if inj := newMCPInjection(svc.profile()); !inj.present() {
			t.Errorf("%s: profile renders no MCP after all", cli)
		}
	}
}

// agy's renderer returns BEFORE any MCP logic — it exposes no per-call inject
// flag — so there is no get_note, and the manifest would name a verb the model
// cannot call. This is the seam the body-injection fallback hangs off.
func TestRendersMCP_FalseForAgy(t *testing.T) {
	svc := retrievalService(t, "agy", fakeMCPEndpoint{url: "http://127.0.0.1:9999/mcp", token: "t"})
	if svc.RendersMCP() {
		t.Fatal("agy: RendersMCP = true, but agy renders no MCP flags")
	}
	// Pinned against the renderer itself: no MCP flag is emitted for agy.
	args := buildBaseArgs("agy", "", "prompt", svc.profile(), "", "/lib")
	if flagValue(args, "--mcp-config") != "" || flagValue(args, "--additional-mcp-config") != "" {
		t.Fatalf("agy rendered an MCP flag after all: %v", args)
	}
}

// No live listener means no reachable server, so an MCP-capable backend still
// has nothing to retrieve through.
func TestRendersMCP_FalseWhenNoEndpointIsLive(t *testing.T) {
	if svc := retrievalService(t, "claude", nil); svc.RendersMCP() {
		t.Error("no endpoint wired: RendersMCP = true")
	}
	if svc := retrievalService(t, "claude", fakeMCPEndpoint{}); svc.RendersMCP() {
		t.Error("endpoint with no URL: RendersMCP = true")
	}
}

// A nil service is the unconfigured floor, not a panic.
func TestRendersMCP_NilServiceIsFalse(t *testing.T) {
	var svc *AIService
	if svc.RendersMCP() {
		t.Fatal("nil AIService reported MCP")
	}
}
