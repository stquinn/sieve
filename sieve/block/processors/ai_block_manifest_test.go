package processors

import (
	"fmt"
	"strings"
	"testing"

	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// stubNodes is a NodesPort double: a uri → Node table, everything else dangling.
type stubNodes struct{ nodes map[string]domain.Node }

func (s stubNodes) Resolve(uri string) (domain.Node, error) {
	if n, ok := s.nodes[uri]; ok {
		return n, nil
	}
	return domain.Node{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, uri)
}

func (s stubNodes) Search(string, int) []domain.Candidate { return nil }

func libraryOfThree() stubNodes {
	return stubNodes{nodes: map[string]domain.Node{
		"container:aaa": {URI: "container:aaa", UUID: "uuid-aaa", Kind: "note", Title: "Auth Design", Summary: "Token exchange."},
		"container:bbb": {URI: "container:bbb", UUID: "uuid-bbb", Kind: "note", Title: "Retry RFC", Summary: "Backoff rules."},
		"container:ccc": {URI: "container:ccc", UUID: "uuid-ccc", Kind: "note", Title: "Rate Limits", Summary: "Quota tiers."},
	}}
}

// aiBlockWithAttachments builds one chain turn.
func aiBlockWithAttachments(id, ref, question, response string, uris ...string) block.SieveBlock {
	blk := block.NewSieveBlock("ai-block", id, map[string]interface{}{
		"id": id, "ref": ref, "type": "ASK",
		"status": block.BlockStatusComplete, "question": question, "response": response,
	})
	var list block.Attachments
	for _, uri := range uris {
		list = append(list, domain.Attachment{URI: uri, Title: "cached " + uri})
	}
	blk.SetAttachments(list)
	return blk
}

// THE per-turn assertion: each ai-block in the chain carries its OWN attachments,
// so each entry emits its own section. This is why attachments could not ride
// `ref` — one field cannot be both the traversal edge and a per-turn property,
// and a three-turn chain where each turn attached different documents is exactly
// where that breaks.
func TestAIBlock_ThreeTurnChain_EachTurnRendersItsOwnManifest(t *testing.T) {
	resetRegistry()
	svc := block.BlockServices{Nodes: libraryOfThree()}
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(svc)
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	seed := []block.SieveBlock{
		block.NewSieveBlock(block.KindProse, "pr-1", map[string]interface{}{"content": "the grass is green"}),
		aiBlockWithAttachments("ab-1", "doc", "turn one?", "answer one", "container:aaa"),
		aiBlockWithAttachments("ab-2", "ab-1", "turn two?", "answer two", "container:bbb"),
		aiBlockWithAttachments("ab-3", "ab-2", "turn three?", "", "container:ccc"),
	}
	body, err := codec.Serialize(seed)
	if err != nil {
		t.Fatalf("seed serialize: %v", err)
	}
	shadow := block.NewShadow("u", body, codec, 0, nil)
	action, doc, ok := shadow.SnapshotForJob("ab-3")
	if !ok {
		t.Fatalf("SnapshotForJob(ab-3) not found; body was:\n%s", body)
	}

	content, history, question := p.buildPrompt(&action, doc)

	// THREAD: two entries, oldest-first, each with its own section.
	if n := strings.Count(history, "ATTACHED DOCUMENTS"); n != 2 {
		t.Fatalf("THREAD rendered %d sections, want one per turn:\n%s", n, history)
	}
	authAt, retryAt := strings.Index(history, "Auth Design"), strings.Index(history, "Retry RFC")
	if authAt < 0 || retryAt < 0 || authAt > retryAt {
		t.Fatalf("THREAD sections are missing or out of order (auth=%d retry=%d):\n%s", authAt, retryAt, history)
	}
	if strings.Contains(history, "Rate Limits") {
		t.Errorf("the ACTION turn's attachment leaked into the THREAD:\n%s", history)
	}

	// ACTION: this turn's attachment only.
	if n := strings.Count(question, "ATTACHED DOCUMENTS"); n != 1 {
		t.Fatalf("ACTION rendered %d sections, want 1:\n%s", n, question)
	}
	if !strings.Contains(question, "Rate Limits") {
		t.Errorf("the ACTION turn lost its own attachment:\n%s", question)
	}
	if strings.Contains(question, "Auth Design") || strings.Contains(question, "Retry RFC") {
		t.Errorf("prior turns' attachments leaked into the ACTION:\n%s", question)
	}

	// TARGET is the document's own content — no attachment ever renders there.
	if strings.Contains(content, "ATTACHED DOCUMENTS") {
		t.Errorf("TARGET carried an attachments section:\n%s", content)
	}

	// The section sits between the question and the answer, per turn.
	if qAt, aAt := strings.Index(history, "ATTACHED DOCUMENTS"), strings.Index(history, "**ANSWER:**"); qAt < 0 || aAt < 0 || qAt > aAt {
		t.Errorf("the section must precede the turn's answer (att=%d ans=%d):\n%s", qAt, aAt, history)
	}
}

// A dangling attachment renders the entry as unavailable rather than failing the
// job — the ask still runs, and the model is told which document it cannot see.
func TestAIBlock_DanglingAttachment_RendersUnavailableAndStillAsks(t *testing.T) {
	resetRegistry()
	svc := block.BlockServices{Nodes: libraryOfThree()}
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(svc)
	blk := aiBlockWithAttachments("ab-1", "doc", "still answerable?", "", "container:gone")
	_, _, question := p.buildPrompt(&blk, block.DocView{})

	if !strings.Contains(question, "still answerable?") {
		t.Fatalf("the question survived nothing:\n%s", question)
	}
	if !strings.Contains(question, "\"unavailable\": true") {
		t.Fatalf("dangling attachment not marked unavailable:\n%s", question)
	}
	if !strings.Contains(question, "cached container:gone") {
		t.Errorf("the cached title is what labels a dangling entry:\n%s", question)
	}
}

// A turn with no attachments is byte-identical to what it was before the attr
// existed — the whole feature is invisible until someone uses it.
func TestAIBlock_NoAttachments_PromptUnchanged(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{Nodes: libraryOfThree()}))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(block.BlockServices{Nodes: libraryOfThree()})
	blk := block.NewSieveBlock("ai-block", "ab-1", map[string]interface{}{
		"id": "ab-1", "ref": "doc", "type": "ASK", "question": "plain question?",
	})
	_, _, question := p.buildPrompt(&blk, block.DocView{})

	if strings.Contains(question, "ATTACHED") {
		t.Fatalf("an attachment-less turn grew a section:\n%s", question)
	}
	if question != (block.AIContext{NodeIDs: []string{"ab-1"}, Content: "QUESTION ABOUT: doc\nplain question?"}).String() {
		t.Fatalf("the attachment-less prompt changed shape:\n%q", question)
	}
}

// The delivery mode is a BACKEND capability, not a per-block choice: the manifest
// is the primary form, and bodies are injected only when the configured backend
// demonstrably renders no MCP (agy) — there is no get_note to point at.
func TestAIBlock_DeliveryDefaultsToManifestWhenNoAIServiceIsWired(t *testing.T) {
	p := NewAIBlockProcessor(block.BlockServices{Nodes: libraryOfThree()})
	if got := p.attachmentDelivery(); got != block.DeliverByManifest {
		t.Fatalf("delivery = %v, want DeliverByManifest", got)
	}
}

// liveMCP is a wired, reachable builtin MCP endpoint. NOTHING here execs a CLI:
// the delivery decision is answered from settings + the rendered profile alone.
type liveMCP struct{}

func (liveMCP) Endpoint() (string, string) { return "http://127.0.0.1:9/mcp", "tok" }
func (liveMCP) Ready() bool                { return true }

// aiServiceForCLI wires a real AIService configured for one CLI dialect.
func aiServiceForCLI(t *testing.T, cli string) *ai.AIService {
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
	prompts, err := ai.NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	documents, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	svc := ai.NewAIService(state, prompts, documents, root)
	svc.SetMCPEndpoint(liveMCP{})
	return svc
}

// End to end for the agy fallback: agy's arg renderer returns before any MCP
// logic, so a manifest would name a verb the model cannot call. The prompt must
// carry the resolved BODY instead — otherwise the ask answers from the title.
func TestAIBlock_AgyBackend_InjectsBodiesInsteadOfTheManifest(t *testing.T) {
	nodes := stubNodes{nodes: map[string]domain.Node{
		"container:aaa": {
			URI: "container:aaa", UUID: "uuid-aaa", Kind: "note", Title: "Auth Design",
			Summary: "Token exchange.", Body: "# Auth Design\n\nTokens rotate every 15 minutes.",
		},
	}}

	agy := NewAIBlockProcessor(block.BlockServices{Nodes: nodes, AI: aiServiceForCLI(t, "agy")})
	if got := agy.attachmentDelivery(); got != block.DeliverByBody {
		t.Fatalf("agy delivery = %v, want DeliverByBody", got)
	}
	blk := aiBlockWithAttachments("ab-1", "doc", "how do tokens rotate?", "", "container:aaa")
	_, _, question := agy.buildPrompt(&blk, block.DocView{})
	if !strings.Contains(question, "Tokens rotate every 15 minutes.") {
		t.Fatalf("agy prompt carries no body:\n%s", question)
	}
	if strings.Contains(question, "get_note") {
		t.Errorf("agy prompt names a verb the model cannot call:\n%s", question)
	}

	// The same block on an MCP-capable backend gets the manifest instead.
	claude := NewAIBlockProcessor(block.BlockServices{Nodes: nodes, AI: aiServiceForCLI(t, "claude")})
	if got := claude.attachmentDelivery(); got != block.DeliverByManifest {
		t.Fatalf("claude delivery = %v, want DeliverByManifest", got)
	}
	_, _, question = claude.buildPrompt(&blk, block.DocView{})
	if strings.Contains(question, "Tokens rotate every 15 minutes.") {
		t.Errorf("an MCP-capable backend must not pay for the body:\n%s", question)
	}
	if !strings.Contains(question, "get_note") {
		t.Errorf("manifest lost its retrieval verb:\n%s", question)
	}
}
