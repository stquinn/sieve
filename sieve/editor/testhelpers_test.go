package editor

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// resetRegistry clears the global processor registry and restores the built-in
// prose terminal — the production baseline an editor/codec test starts from.
func resetRegistry() {
	block.ResetRegistry()
	block.RegisterProcessor(&processors.ProseProcessor{})
}

// newTestDocumentService creates a DocumentService backed by a temporary FileStore.
func newTestDocumentService(t *testing.T) (*services.DocumentService, *filestore.FileStore) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}

	return ds, fs
}

// containerKind is the block kind the editor's tests put in a container.
const containerKind = "code"

// newTestContainers builds the container service beside the document service over
// one temporary store, with containerKind registered.
func newTestContainers(t *testing.T) (*services.BlockContainerService, *services.DocumentService, *filestore.FileStore) {
	t.Helper()
	withCodeProcessor(t)
	ds, st := newTestDocumentService(t)
	containers, err := services.NewBlockContainerService(st, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	return containers, ds, st
}

// newTestChats builds the chat service over the store the container and document
// services share.
func newTestChats(t *testing.T) (*services.ChatService, *services.BlockContainerService, *services.DocumentService, *filestore.FileStore) {
	t.Helper()
	containers, ds, st := newTestContainers(t)
	chats, err := services.NewChatService(st, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	return chats, containers, ds, st
}

// answeredExchange is a completed ai-block whose question and answer are each one
// prose element.
func answeredExchange(question, answer string) domain.SieveBlock {
	b := domain.NewSieveBlock(block.KindAIBlock, "", map[string]interface{}{"status": block.BlockStatusComplete})
	b.SetElements(block.QuestionAttr, domain.Elements{domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": question})})
	b.SetElements(block.AnswerAttr, domain.Elements{domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": answer})})
	return b
}

// answerEndpoint stands in for the Sieve MCP a run is handed: it binds the run to
// the exchange it answers and counts the answer blocks written for it, as the
// MCP's add_to_answer does.
type answerEndpoint struct {
	mu      sync.Mutex
	ex      domain.Exchange
	written int
}

func (e *answerEndpoint) EndpointFor(ex domain.Exchange, _ bool) (string, string, []string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ex, e.written = ex, 0
	return "http://127.0.0.1:1/mcp", "run-token", []string{"add_to_answer"}
}

func (e *answerEndpoint) EndRun(string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.written
}

// exchange is the exchange the current run answers.
func (e *answerEndpoint) exchange() domain.Exchange {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.ex
}

// write adds a prose block holding text to the answer of the exchange the run
// answers, through es, as add_to_answer does: the run's first block replaces
// any earlier answer.
func (e *answerEndpoint) write(es *EditorService, text string) error {
	e.mu.Lock()
	ex, first := e.ex, e.written == 0
	e.mu.Unlock()
	if err := es.AppendToAnswer(ex, domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": text}), first); err != nil {
		return err
	}
	e.mu.Lock()
	e.written++
	e.mu.Unlock()
	return nil
}

// modelCLI is a CLI runner standing in for a model: each run is the function,
// handed the exchange it answers, and its result the run's final message.
type modelCLI struct {
	endpoint *answerEndpoint
	answer   func(ex domain.Exchange) (string, error)
}

func (m modelCLI) Run(ai.Run, ai.ResponseNote) (string, error) {
	return m.answer(m.endpoint.exchange())
}

// newChatEditor builds an editor that opens chats, wired as the composition root
// wires it, over one new chat it answers the uuid of. An exchange's job runs the
// real ai-block processor and AIService in the smart tier, its CLI run being
// answer; with no engine wired, WaitForJobs waits for the run.
func newChatEditor(t *testing.T, answer func(ex domain.Exchange) (string, error)) (*EditorService, *services.ChatService, *answerEndpoint, string) {
	t.Helper()
	resetRegistry()
	t.Cleanup(resetRegistry)
	chats, containers, ds, fs := newTestChats(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetChats(chats)
	es.SetContainers(containers)
	t.Cleanup(es.CloseAll)

	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	// The tier probes the CLI binary on disk, so a stub that is never run stands
	// in for one.
	stub := filepath.Join(t.TempDir(), "stub-ai-cli")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write stub CLI: %v", err)
	}
	settings := domain.DefaultSettings()
	settings.CLI, settings.CLIPath = "claude", stub
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	prompts, err := ai.NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	endpoint := &answerEndpoint{}
	aiSvc := ai.NewAIService(state, prompts, ds, nil, "")
	aiSvc.SetMCPEndpoint(endpoint)
	aiSvc.SetRunner(modelCLI{endpoint: endpoint, answer: answer})
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{AI: aiSvc, State: state}))

	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return es, chats, endpoint, c.UUID()
}

// prose is a question block holding text, as a composer sends it: with no id.
func prose(text string) domain.SieveBlock {
	return domain.SieveBlock{Kind: block.KindProse, Attrs: map[string]interface{}{"content": text}}
}
