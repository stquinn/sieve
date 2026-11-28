package editor

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// newContainerEditor builds an editor that opens block containers, wired the way
// the composition root wires it, over one containerKind container. Filing goes
// to a counting filer on a real engine.
func newContainerEditor(t *testing.T) (*EditorService, *services.BlockContainerService, *domain.BlockContainer, *countingFiler) {
	t.Helper()
	containers, ds, _ := newTestContainers(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetContainers(containers)
	containers.SetChangeListener(es)
	es.SetEngine(services.NewJobEngine(map[string]int{"ai": 1}, 1, services.NewJobTracker()))
	filer := &countingFiler{seen: map[string]int{}}
	es.ai = filer
	t.Cleanup(es.CloseAll)

	c, err := containers.Create(containerKind, map[string]interface{}{"title": "a snippet", "source": "x := 1"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return es, containers, c, filer
}

func TestContainerSession_OpensItsOneBlockWithoutAShadow(t *testing.T) {
	es, _, c, _ := newContainerEditor(t)
	uuid := c.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if es.sessionFor(uuid) == nil || es.shadowFor(uuid) != nil {
		t.Fatalf("want a session with no shadow")
	}
	if got := es.openUUIDs(); len(got) != 0 {
		t.Errorf("openUUIDs = %v, want no documents", got)
	}
	blocks, ok := es.FrontendBlocks(uuid)
	if !ok || len(blocks) != 1 || blocks[0].ID != uuid || blocks[0].Kind != containerKind || blocks[0].Attrs["source"] != "x := 1" {
		t.Fatalf("FrontendBlocks = %+v, %v; want the container's one block", blocks, ok)
	}
	if version, stored := es.ContainerVersion(uuid); !stored || version != c.Version() {
		t.Errorf("ContainerVersion = %d, %t; want %d", version, stored, c.Version())
	}

	es.Close(uuid)
	closed, err := es.Blocks(uuid)
	if err != nil || len(closed) != 1 || closed[0].ID != uuid {
		t.Errorf("Blocks of the closed container = %+v, %v", closed, err)
	}
	if err := es.Open(testMissingUUID); err == nil {
		t.Error("Open of a uuid naming nothing succeeded")
	}
}

// nodeResolver resolves one uuid, until it is gone, to a node of kind nodeKind with the attrs it
// holds; every other address is domain.ErrNodeNotFound.
type nodeResolver struct {
	uuid string

	mu    sync.Mutex
	attrs map[string]interface{}
	gone  bool
}

const nodeKind = "test-node"

func (r *nodeResolver) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if addr.Container != r.uuid || r.gone {
		return domain.NodeDescriptor{}, domain.ErrNodeNotFound
	}
	return domain.NodeDescriptor{ID: r.uuid, Kind: nodeKind, Attrs: r.attrs}, nil
}

func (r *nodeResolver) set(attrs map[string]interface{}, gone bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attrs, r.gone = attrs, gone
}

// newNodeEditor builds an editor that opens block containers and the one node a nodeResolver
// resolves, wired as the composition root wires it.
func newNodeEditor(t *testing.T) (*EditorService, *nodeResolver) {
	t.Helper()
	es, _, _, _ := newContainerEditor(t)
	nodes := &nodeResolver{uuid: "019a0000-0000-7000-8000-00000000beef", attrs: map[string]interface{}{"page": "p1"}}
	es.SetNodes(nodes)
	return es, nodes
}

func TestNodeSession_OpensTheNodesOneBlockAndClosesWhenItNoLongerResolves(t *testing.T) {
	es, nodes := newNodeEditor(t)
	type pushed struct {
		blockID string
		attrs   map[string]interface{}
	}
	var got []pushed
	es.SetLifecycleListener(&mockLifecycleListener{onUpdated: func(_, blockID string, attrs map[string]interface{}) {
		got = append(got, pushed{blockID, attrs})
	}})
	if err := es.Open(nodes.uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	blocks, ok := es.FrontendBlocks(nodes.uuid)
	if !ok || len(blocks) != 1 || blocks[0].ID != nodes.uuid || blocks[0].Kind != nodeKind || blocks[0].Attrs["page"] != "p1" {
		t.Fatalf("FrontendBlocks = %+v, %v; want the node's one block", blocks, ok)
	}
	if _, stored := es.ContainerVersion(nodes.uuid); es.shadowFor(nodes.uuid) != nil || len(es.openUUIDs()) != 0 || stored {
		t.Error("a node opened as a document or a stored container")
	}

	nodes.set(map[string]interface{}{"page": "p2"}, false)
	if err := es.Refresh(nodes.uuid); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if len(got) != 1 || got[0].blockID != nodes.uuid || got[0].attrs["page"] != "p2" {
		t.Fatalf("pushed %+v, want one attrs update carrying the node's new attrs", got)
	}
	if blocks, _ := es.FrontendBlocks(nodes.uuid); blocks[0].Attrs["page"] != "p2" {
		t.Errorf("the session still holds %v", blocks[0].Attrs["page"])
	}

	nodes.set(nil, true)
	if err := es.Refresh(nodes.uuid); err != nil {
		t.Fatalf("Refresh of a node gone: %v", err)
	}
	if es.sessionFor(nodes.uuid) != nil || len(got) != 1 {
		t.Errorf("a node that no longer resolves: session %v, pushed %+v", es.sessionFor(nodes.uuid), got)
	}
	if err := es.Open(nodes.uuid); err == nil {
		t.Error("Open of a node that no longer resolves succeeded")
	}
}

// A block container and a node are read-only sessions: every document verb refuses them, naming
// what they are, and leaves what they hold as it was. They hold no jobs: an answer is refused, and
// a dispatch or a run of a job does nothing.
func TestReadOnlySessions_RefuseEveryDocumentVerb(t *testing.T) {
	for _, session := range []struct {
		name, says string
		open       func(t *testing.T) (es *EditorService, uuid, kind string)
	}{
		{"block container", "is a block container", func(t *testing.T) (*EditorService, string, string) {
			es, _, c, _ := newContainerEditor(t)
			return es, c.UUID(), containerKind
		}},
		{"node", "is a " + nodeKind + " node", func(t *testing.T) (*EditorService, string, string) {
			es, nodes := newNodeEditor(t)
			return es, nodes.uuid, nodeKind
		}},
	} {
		t.Run(session.name, func(t *testing.T) {
			es, uuid, kind := session.open(t)
			if err := es.Open(uuid); err != nil {
				t.Fatalf("Open: %v", err)
			}
			before, _ := es.FrontendBlocks(uuid)
			entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "SELECT 1"}}

			for _, tc := range []struct {
				name string
				verb func() error
			}{
				{"create-block", func() error {
					return es.HandleBlockOp(uuid, block.BlockOp{Type: "create-block", Kind: kind})
				}},
				{"update-block", func() error {
					return es.HandleBlockOp(uuid, block.BlockOp{Type: "update-block", BlockID: uuid, Kind: kind, Attrs: map[string]interface{}{"source": "y"}})
				}},
				{"delete-block", func() error { return es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: uuid}) }},
				{"doc-update", func() error { return es.UpdateMarkdown(uuid, "# replaced") }},
				{"retry-block-job", func() error { return es.RetryBlockJob(uuid, uuid) }},
				{"update-block merge", func() error {
					return es.UpdateBlock(uuid, domain.SieveBlock{ID: uuid, Attrs: map[string]interface{}{"status": "PENDING"}})
				}},
				{"text-replace", func() error {
					return es.ReplaceText(uuid, domain.TextEdit{BlockID: uuid, Quote: "x", Grain: domain.GrainLiteral})
				}},
				{"export", func() error { _, err := es.Export(uuid, nil, block.MarkdownGenerator{}); return err }},
				{"enter-markdown", func() error { _, err := es.EnterMarkdown(uuid); return err }},
				{"enter-wysiwyg", func() error { return es.EnterWysiwyg(uuid) }},
				{"flush", func() error { return es.Flush(uuid) }},
				{"create", func() error { _, _, err := es.CreateBlock(uuid, kind, nil, block.AppendIndex); return err }},
				{"paste-slice", func() error { _, err := es.HandlePasteSlice(uuid, [][]block.ContentEntry{entries}, 0); return err }},
				{"extract", func() error {
					_, _, err := es.CreateBlockFromEntries(uuid, kind, entries, block.ActionExtract, uuid)
					return err
				}},
				{"transform", func() error {
					_, _, err := es.CreateBlockFromEntries(uuid, kind, entries, block.ActionTransform, uuid)
					return err
				}},
				{"jobs", func() error { _, err := es.sessionFor(uuid).jobs(); return err }},
				{"append-to-answer", func() error {
					return es.AppendToAnswer(domain.Exchange{Container: uuid, Block: uuid}, domain.NewSieveBlock(block.KindProse, "", nil), false)
				}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					err := tc.verb()
					if !errors.Is(err, ErrNotDocument) {
						t.Errorf("err = %v, want ErrNotDocument", err)
					}
					if err != nil && !strings.Contains(err.Error(), session.says) {
						t.Errorf("err = %v, want it to say it %s", err, session.says)
					}
				})
			}
			for name, paste := range map[string]func() block.PasteResult{
				"paste":     func() block.PasteResult { return es.HandlePaste(uuid, entries, 0) },
				"placement": func() block.PasteResult { return es.HandlePlacement(uuid, entries, 0) },
			} {
				if res := paste(); res.Outcome != block.OutcomeNothing {
					t.Errorf("%s = %+v, want nothing", name, res)
				}
			}
			es.DispatchJobIfNeeded(uuid, uuid)
			es.RunJob(context.Background(), uuid, uuid)
			es.WaitForJobs()
			if after, _ := es.FrontendBlocks(uuid); fmt.Sprint(after) != fmt.Sprint(before) {
				t.Errorf("a refused verb changed the session: %+v → %+v", before, after)
			}
		})
	}
}

func TestContainerSession_CloseFlushesAndFilesNothing(t *testing.T) {
	es, containers, c, filer := newContainerEditor(t)
	uuid := c.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	es.CloseDocument(uuid)
	es.Close(uuid)
	es.CloseDocument(uuid)
	es.CloseAllAndFile([]string{uuid})
	es.FileDocument(uuid)
	es.WaitForJobs()
	waitFiling(t, func() bool { return filer.count(uuid) > 0 })

	if got := filer.count(uuid); got != 0 {
		t.Errorf("a block container was filed %d time(s)", got)
	}
	if stored, err := containers.Load(uuid); err != nil || stored.Version() != c.Version() {
		t.Errorf("closing wrote the container: version %d → %v (%v)", c.Version(), stored, err)
	}
}

func TestContainerSession_ASaveReachesTheOpenSessionAsAnAttrsUpdate(t *testing.T) {
	es, containers, c, _ := newContainerEditor(t)
	uuid := c.UUID()
	type pushed struct {
		uuid, blockID string
		attrs         map[string]interface{}
	}
	var got []pushed
	es.SetLifecycleListener(&mockLifecycleListener{onUpdated: func(uuid, blockID string, attrs map[string]interface{}) {
		got = append(got, pushed{uuid, blockID, attrs})
	}})

	c.Merge(map[string]interface{}{"source": "before open"})
	c, err := containers.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a save with no session open pushed %+v", got)
	}

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	c.Merge(map[string]interface{}{"source": "y := 2"})
	if _, err := containers.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(got) != 1 || got[0].uuid != uuid || got[0].blockID != uuid || got[0].attrs["source"] != "y := 2" {
		t.Fatalf("pushed %+v, want one attrs update carrying the saved source", got)
	}
	if blocks, _ := es.FrontendBlocks(uuid); blocks[0].Attrs["source"] != "y := 2" {
		t.Errorf("the session still holds %v", blocks[0].Attrs["source"])
	}
}

// namingListener is a lifecycle listener that hears names.
type namingListener struct {
	mockLifecycleListener
	named []string
}

func (l *namingListener) OnContainerNamed(uuid, name string) {
	l.named = append(l.named, uuid+" "+name)
}

// An open block container answers what it is called; a write that changes the name, a Save or a
// SaveMeta alike, reaches the open session as the new name, and one that leaves it alone does not.
func TestContainerSession_ANewNameReachesTheOpenSession(t *testing.T) {
	es, containers, c, _ := newContainerEditor(t)
	uuid := c.UUID()
	heard := &namingListener{}
	es.SetLifecycleListener(heard)
	if _, open := es.ContainerName(uuid); open {
		t.Error("a container no session holds has a name")
	}
	if err := es.Open(uuid); err != nil {
		t.Fatal(err)
	}
	if name, open := es.ContainerName(uuid); !open || name != "a snippet" {
		t.Errorf("ContainerName = %q, %v", name, open)
	}
	if _, err := containers.SaveMeta(uuid, func(m domain.DocumentMeta) { m.All()["foreign"] = "x" }); err != nil {
		t.Fatal(err)
	}
	c.Merge(map[string]interface{}{"title": "renamed"})
	if _, err := containers.Save(c); err != nil {
		t.Fatal(err)
	}
	if name, _ := es.ContainerName(uuid); name != "renamed" || strings.Join(heard.named, ",") != uuid+" renamed" {
		t.Errorf("ContainerName = %q, heard %v", name, heard.named)
	}
}

// answerTexts are the contents of the blocks of exchange's answer, in order.
func answerTexts(exchange domain.SieveBlock) []string {
	var out []string
	for _, el := range exchange.Elements(block.AnswerAttr) {
		out = append(out, el.Content())
	}
	return out
}

// An exchange asked in a chat becomes an ai-block whose question is the asked
// blocks verbatim, is saved, announced as a created block and answered: with
// blocks written through add_to_answer, its final message discarded, or with its
// final message. It is answered alike when the chat is closed before the answer
// settles: what was written while it was open is kept, and the settle opens the
// chat for the write and closes it again. The saves that follow the first
// question name the untitled chat once, by that question's opening words.
// The end of the exchange's job is heard once, after the save that holds its
// answer.
func TestChatSession_AnExchangeIsAnsweredOpenOrClosed(t *testing.T) {
	for _, tc := range []struct {
		name    string
		written []string // blocks the model writes with add_to_answer
		closes  bool     // the chat is closed before the answer settles
		want    []string
	}{
		{"written with add_to_answer, in an open chat", []string{"First block.", "Second block."}, false, []string{"First block.", "Second block."}},
		{"written with add_to_answer, in a chat closed before it settles", []string{"First block.", "Second block."}, true, []string{"First block.", "Second block."}},
		{"a final message, in an open chat", nil, false, []string{"the final message"}},
		{"a final message, in a chat closed before it settles", nil, true, []string{"the final message"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wrote, release := make(chan struct{}), make(chan struct{})
			var es *EditorService
			var endpoint *answerEndpoint
			es, chats, endpoint, uuid := newChatEditor(t, func(domain.Exchange) (string, error) {
				for _, text := range tc.written {
					if err := endpoint.write(es, text); err != nil {
						return "", err
					}
				}
				if tc.closes {
					close(wrote)
					<-release
				}
				return "the final message", nil
			})
			saves := newRecordingSaves()
			es.SetSavedNotifier(saves)
			es.SetChatAnsweredListener(saves)
			var created []string
			es.SetLifecycleListener(&mockLifecycleListener{onCreated: func(_, kind, id, _ string) { created = append(created, kind+" "+id) }})
			if err := es.Open(uuid); err != nil {
				t.Fatalf("Open: %v", err)
			}

			id, err := es.AppendExchange(uuid, []domain.SieveBlock{prose("What is a chat?"), prose("And a turn?")})
			if err != nil {
				t.Fatalf("AppendExchange: %v", err)
			}
			if fact := saves.await(t, time.Second); fact.uuid != uuid {
				t.Errorf("the save announced %q, want the chat %q", fact.uuid, uuid)
			}
			if fmt.Sprint(created) != fmt.Sprint([]string{block.KindAIBlock + " " + id}) {
				t.Errorf("created = %v, want the exchange", created)
			}
			if tc.closes {
				<-wrote
				es.Close(uuid)
				close(release)
			}
			es.WaitForJobs()

			if open := es.sessionFor(uuid) != nil; open == tc.closes {
				t.Errorf("the chat is open: %v, want %v", open, !tc.closes)
			}
			if got, want := saves.namings(), []string{uuid + " What is a chat? And a turn?"}; fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("the chat was named %v, want %v", got, want)
			}
			// The ask is heard once; the saves that write its answer are not asks.
			if got, want := saves.asks(), []string{uuid}; fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("the chat was asked %v, want %v", got, want)
			}
			if got, want := saves.answers(), []string{uuid}; fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("the end of the exchange's job was heard %v, want %v", got, want)
			}
			stored, err := chats.Load(uuid)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			exchanges := stored.Exchanges()
			if len(exchanges) != 1 || exchanges[0].ID != id || exchanges[0].Kind != block.KindAIBlock {
				t.Fatalf("the chat holds %+v, want the one exchange", exchanges)
			}
			var question []string
			for _, el := range exchanges[0].Elements(block.QuestionAttr) {
				if el.ID == "" {
					t.Errorf("a question element has no id: %+v", el)
				}
				question = append(question, el.Kind+": "+el.Content())
			}
			if fmt.Sprint(question) != fmt.Sprint([]string{"prose: What is a chat?", "prose: And a turn?"}) {
				t.Errorf("question = %v, want the asked blocks in order", question)
			}
			if got := answerTexts(exchanges[0]); exchanges[0].Status() != block.BlockStatusComplete || fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("answer = %v (status %s), want %v, COMPLETE", got, exchanges[0].Status(), tc.want)
			}
		})
	}
}

// A chat only grows. An exchange with no answer is kept across a close and a
// reopen, and may be asked again: its job runs and answers it. An answered
// exchange, or one being answered, is not asked again, and nothing that is not
// an exchange of an open chat is retried or asked. A job a restart stranded is
// run again when the chat is opened.
func TestChatSession_TheListOnlyGrows(t *testing.T) {
	var fails atomic.Bool
	fails.Store(true)
	es, chats, _, uuid := newChatEditor(t, func(domain.Exchange) (string, error) {
		if fails.Load() {
			return "", errors.New("cli exited with status 1")
		}
		return "An answer.", nil
	})
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	id, err := es.AppendExchange(uuid, []domain.SieveBlock{prose("Will this fail?")})
	if err != nil {
		t.Fatalf("AppendExchange: %v", err)
	}
	es.WaitForJobs()
	es.Close(uuid)
	if err := es.RetryBlockJob(uuid, id); !errors.Is(err, ErrNotOpen) {
		t.Errorf("a retry in a closed chat: %v, want ErrNotOpen", err)
	}
	if _, err := es.AppendExchange(uuid, []domain.SieveBlock{prose("Closed?")}); !errors.Is(err, ErrNotOpen) {
		t.Errorf("an ask in a closed chat: %v, want ErrNotOpen", err)
	}

	if err := es.Open(uuid); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	blocks, _ := es.Blocks(uuid)
	if len(blocks) != 1 || blocks[0].ID != id || blocks[0].Status() != block.BlockStatusError || len(answerTexts(blocks[0])) != 0 {
		t.Fatalf("after a reopen the chat holds %+v, want the unanswered exchange", blocks)
	}

	fails.Store(false)
	if err := es.RetryBlockJob(uuid, id); err != nil {
		t.Fatalf("a retry of an unanswered exchange: %v", err)
	}
	es.WaitForJobs()
	blocks, _ = es.Blocks(uuid)
	if fmt.Sprint(answerTexts(blocks[0])) != fmt.Sprint([]string{"An answer."}) || blocks[0].StringAttr("error") != "" {
		t.Fatalf("the retry left %+v, want the exchange answered", blocks[0].Attrs)
	}

	for name, retry := range map[string]func() error{
		"an answered exchange": func() error { return es.RetryBlockJob(uuid, id) },
		"an id the chat lacks": func() error { return es.RetryBlockJob(uuid, ident.New()) },
	} {
		if err := retry(); err == nil {
			t.Errorf("a retry of %s was taken", name)
		}
	}
	if err := es.sessionFor(uuid).admitRetry(blocks[0].Elements(block.AnswerAttr)[0].ID); err != nil {
		t.Errorf("a block nested in an answer is refused by the chat's own rule: %v", err)
	}
	if _, err := es.AppendExchange(uuid, nil); err == nil {
		t.Error("an ask with no question was taken")
	}
	if after, _ := es.Blocks(uuid); len(after) != 1 || fmt.Sprint(answerTexts(after[0])) != fmt.Sprint([]string{"An answer."}) {
		t.Errorf("a refused verb changed the chat: %+v", after)
	}
	if err := es.Flush(uuid); !errors.Is(err, ErrNotDocument) || !strings.Contains(err.Error(), "is a chat") {
		t.Errorf("a document verb in a chat: %v, want ErrNotDocument naming a chat", err)
	}
	es.Close(uuid)

	stranded := answeredExchange("Stranded?", "")
	stranded.SetElements(block.AnswerAttr, nil)
	stranded.Attrs["status"] = block.BlockStatusDispatched
	c, err := chats.Load(uuid)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	c.SetExchanges(append(c.Exchanges(), stranded))
	if _, err := chats.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	es.WaitForJobs()
	stored, _ := chats.Load(uuid)
	if got := stored.Exchanges(); len(got) != 2 || got[1].Status() != block.BlockStatusComplete || fmt.Sprint(answerTexts(got[1])) != fmt.Sprint([]string{"An answer."}) {
		t.Errorf("the stranded exchange was not run again on open: %+v", got)
	}
}
