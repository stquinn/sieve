package ai

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"sieve/sieve/domain"
	"sieve/store"
)

type mockStorable struct {
	key      string
	category store.Category
	body     []byte
}

func (m *mockStorable) Key() string                  { return m.key }
func (m *mockStorable) Path() string                 { return m.key }
func (m *mockStorable) Category() store.Category     { return m.category }
func (m *mockStorable) Body() []byte                 { return m.body }
func (m *mockStorable) ExternalRef() string          { return "" }
func (m *mockStorable) Versions() []store.VersionRef { return nil }
func (m *mockStorable) IsModified() bool             { return false }

type mockStore struct {
	files map[string]*mockStorable
}

func newMockStore() *mockStore {
	return &mockStore{files: make(map[string]*mockStorable)}
}

func (m *mockStore) CreateText(cat store.Category, key string, body []byte) (store.Storable, error) {
	s := &mockStorable{key: key, category: cat, body: body}
	m.files[cat.Key+":"+key] = s
	return s, nil
}

func (m *mockStore) Load(cat store.Category, key string) (store.Storable, error) {
	s, ok := m.files[cat.Key+":"+key]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return s, nil
}

func (m *mockStore) Delete(s store.Storable) error {
	delete(m.files, s.Category().Key+":"+s.Key())
	return nil
}

// This mock keys everything by category and key, so there is no uuid resolution
// left over to forget.
func (m *mockStore) ForgetUUIDs(uuids []string) {}

func (m *mockStore) PrepareCategory(cat store.Category) error { return nil }

// Unimplemented methods to satisfy Store interface
func (m *mockStore) CreateMetaText(cat store.Category, key string, body []byte) (store.MetaStorable, error) {
	return nil, nil
}
func (m *mockStore) CreateTyped(category store.Category, key string, contentType string, meta map[string]string, body []byte) (store.MetaStorable, error) {
	return nil, nil
}
func (m *mockStore) CreateAsset(cat store.Category, parentKey, assetID string, body []byte) (store.AssetStorable, error) {
	return nil, nil
}
func (m *mockStore) AppendAsset(cat store.Category, parentKey, assetKey string, data []byte) (store.AssetStorable, error) {
	return nil, nil
}
func (m *mockStore) Save(s store.Storable) (store.Storable, error) { return nil, nil }
func (m *mockStore) List(cat store.Category, prefix string) ([]store.Storable, error) {
	return nil, nil
}
func (m *mockStore) Move(s store.Storable, cat store.Category) (store.Storable, error) {
	return nil, nil
}
func (m *mockStore) Reparent(s store.Storable, folder store.FolderStorable) (store.Storable, error) {
	return nil, nil
}
func (m *mockStore) Rename(s store.Storable, newKey string) (store.Storable, error) { return nil, nil }
func (m *mockStore) RetrieveVersion(s store.Storable, ref store.VersionRef) (store.VersionedStorable, error) {
	return store.VersionedStorable{}, nil
}
func (m *mockStore) CreateOrLoadFolder(cat store.Category, name string) (store.FolderStorable, error) {
	return nil, nil
}
func (m *mockStore) LoadFolder(cat store.Category, name string) (store.FolderStorable, error) {
	return nil, nil
}
func (m *mockStore) RenameFolder(s store.FolderStorable, name string) (store.FolderStorable, error) {
	return nil, nil
}
func (m *mockStore) ListFrom(categories []store.Category, prefix string) ([]store.Storable, error) {
	return nil, nil
}
func (m *mockStore) LoadByUUID(uuid string) (store.Storable, error) { return nil, nil }
func (m *mockStore) LoadAsset(cat store.Category, parentKey, assetKey string) (store.AssetStorable, error) {
	return nil, nil
}
func (m *mockStore) SaveMeta(s store.MetaStorable) (store.MetaStorable, error)        { return nil, nil }
func (m *mockStore) DeleteAsset(cat store.Category, parentKey, assetKey string) error { return nil }

// A task's addendum is the one text the Prompts dialog edits: stored apart from
// the brief, empty when absent, deleted by saving nothing, and listed as the
// entry's state.
func TestPromptService_Addendum(t *testing.T) {
	ps, err := NewPromptService(newMockStore())
	if err != nil {
		t.Fatal(err)
	}
	listed := func() PromptEntry {
		for _, e := range ps.ListPrompts() {
			if e.Name == "file" {
				return e
			}
		}
		t.Fatal("file task not listed")
		return PromptEntry{}
	}

	if got, err := ps.Addendum("file"); err != nil || got != "" {
		t.Errorf("Addendum with none = %q, %v; want empty text, not the brief", got, err)
	}
	if !listed().IsVirtual {
		t.Error("a task with no addendum is not listed as having none")
	}

	if err := ps.SaveAddendum("file", "prefer short folder names"); err != nil {
		t.Fatalf("save failed: %v", err)
	}
	if got, _ := ps.Addendum("file"); got != "prefer short folder names" {
		t.Errorf("Addendum = %q, want what was saved", got)
	}
	if e := listed(); e.IsVirtual {
		t.Errorf("a task with an addendum is listed as having none: %+v", e)
	}

	for _, empty := range []string{"", "  \n\t "} {
		if err := ps.SaveAddendum("file", "prefer short folder names"); err != nil {
			t.Fatal(err)
		}
		if err := ps.SaveAddendum("file", empty); err != nil {
			t.Fatalf("saving %q failed: %v", empty, err)
		}
		if _, err := ps.st.Load(domain.Prompts, "file.addendum.md"); err == nil {
			t.Errorf("saving %q left an addendum stored", empty)
		}
	}

	if err := ps.SaveAddendum("file", "to delete"); err != nil {
		t.Fatal(err)
	}
	if err := ps.DeleteAddendum("file"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if got, _ := ps.Addendum("file"); got != "" {
		t.Errorf("Addendum after delete = %q, want empty", got)
	}
	if err := ps.DeleteAddendum("file"); err != nil {
		t.Errorf("deleting a missing addendum failed: %v", err)
	}

	for _, name := range []string{"nope", ""} {
		if _, err := ps.Addendum(name); err == nil {
			t.Errorf("Addendum(%q) found a task", name)
		}
		if err := ps.SaveAddendum(name, "text"); err == nil {
			t.Errorf("SaveAddendum(%q) stored an addendum for no task", name)
		}
	}
}

// A {task}.md in the Prompts category is an old whole-prompt override: it is
// removed when the service is built, never read, and nothing else there is
// touched.
func TestNewPromptService_RemovesOldOverrides(t *testing.T) {
	st := newMockStore()
	for _, key := range []string{"file.md", "ask.md", "notes.md", "file.addendum.md"} {
		if _, err := st.CreateText(domain.Prompts, key, []byte("stored "+key)); err != nil {
			t.Fatal(err)
		}
	}
	ps, err := NewPromptService(st)
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]bool{"file.md": false, "ask.md": false, "notes.md": true, "file.addendum.md": true} {
		if _, err := st.Load(domain.Prompts, key); (err == nil) != want {
			t.Errorf("%s stored after construction: %v, want %v", key, err == nil, want)
		}
	}
	if got, _ := ps.Addendum("ask"); got != "" {
		t.Errorf("Addendum(ask) = %q; the old override was read", got)
	}
	task, _ := ps.Task("ask")
	if p := ps.Prompt(task, BtwData{}, "", false); !p.Addendum.IsEmpty() || p.Brief != task.Brief {
		t.Errorf("a removed override reached the prompt: %+v", p)
	}
}

// The eleven tasks are declared once, in the order the Prompts dialog lists them,
// each with its display name, its output and its brief, which carries no
// placeholder and nothing of what the framework says.
//
// A task's prompt is the framework's Background, a Delivery layer for a CONTENT
// task alone, its brief, the task's addendum when it has one, then its data;
// layers 1 to 3 are its System and the addendum and data its Input, so an
// addendum displaces none of the first three. A run carrying the Sieve tools is told of them and, when it
// answers, of add_to_answer; a run without them hears of no tool.
func TestPromptService_DeclaresTheTasks(t *testing.T) {
	ps, err := NewPromptService(newMockStore())
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		name, display string
		output        Output
		brief         string
	}{
		{"file", "Smart Filing", Data, DefaultFilingPrompt},
		{"explain", "Explain Content", Content, DefaultExplainPrompt},
		{"ask", "In-context Chat", Content, DefaultAskPrompt},
		{"chat", "Chat", Content, DefaultChatPrompt},
		{"btw", "Quick Answer (/btw)", Content, DefaultBtwPrompt},
		{"refine", "Language Detection", Data, DefaultRefinePrompt},
		{"image", "Describe Image", Data, DefaultImagePrompt},
		{"note-meta", "Name Handwritten Note", Data, DefaultNoteMetaPrompt},
		{"chat-meta", "Name Chat", Data, DefaultChatMetaPrompt},
		{"page-transcript", "Transcribe Handwritten Page", Data, DefaultPageTranscriptPrompt},
		{"web-clip-fetch", "Web Clip — Fetch", Data, DefaultWebClipFetchPrompt},
		{"web-clip-summarise", "Web Clip — Summarise", Data, DefaultWebClipSummarisePrompt},
	}
	list := ps.ListPrompts()
	if len(list) != len(want) {
		t.Fatalf("ListPrompts lists %d tasks, want %d", len(list), len(want))
	}
	placeholder := regexp.MustCompile(`\{[a-z_]+\}`)
	data := WebClipFetchData{Source: "https://example.com"}
	if !strings.Contains(sieveBackground, "a block's address is its container's address, a /, and the block's id") || strings.Contains(sieveBackground, "never construct") {
		t.Error("the Background does not say how an address is formed, or still forbids constructing one")
	}
	tools := []string{"add_to_answer", "describe_answer", "get_note", "get_by_uri", "MCP", "Sieve tools"}
	for i, w := range want {
		t.Run(w.name, func(t *testing.T) {
			task, err := ps.Task(w.name)
			if err != nil {
				t.Fatal(err)
			}
			if wantTask := (Task{Name: w.name, DisplayName: w.display, Output: w.output, Brief: Layer{Heading: briefHeading, Text: w.brief}}); task != wantTask {
				t.Errorf("task = %+v, want %+v", task, wantTask)
			}
			if e := list[i]; e.ID != "prompt:"+w.name || e.Name != w.name || e.DisplayName != w.display || !e.IsVirtual {
				t.Errorf("ListPrompts()[%d] = %+v", i, e)
			}
			if p := placeholder.FindString(w.brief); p != "" {
				t.Errorf("the brief carries the placeholder %s", p)
			}
			for _, framework := range append(tools, "DIRECT ANSWER ONLY", "SILENT OPERATION", "File Access Scope", "Tool Usage") {
				if strings.Contains(w.brief, framework) {
					t.Errorf("the brief says %q, which is the framework's to say", framework)
				}
			}
			for _, addendum := range []string{"", "  always answer in French\n"} {
				if err := ps.SaveAddendum(w.name, addendum); err != nil {
					t.Fatal(err)
				}
				for _, c := range []struct{ container, dataLine string }{{"", ""}, {"uuid-1", "Container: sieve://uuid-1\n\n"}} {
					for _, sieveTools := range []bool{true, false} {
						prompt := ps.Prompt(task, data, c.container, sieveTools)
						background, delivery := sieveBackground, ""
						if sieveTools {
							background += "\n\n" + sieveToolsBackground
						}
						switch {
						case w.output == Content && sieveTools:
							delivery = answerToolGuidance
						case w.output == Content:
							delivery = answerPlainGuidance
						}
						wantPrompt := Prompt{
							Background: Layer{Heading: "# Sieve", Text: background},
							Brief:      task.Brief,
							Data:       Layer{Heading: "# Data", Text: c.dataLine + data.Text()},
						}
						if delivery != "" {
							wantPrompt.Delivery = Layer{Heading: "# Answer", Text: delivery}
						}
						if addendum != "" {
							wantPrompt.Addendum = Layer{Heading: "# Addendum", Text: addendum}
						}
						if prompt != wantPrompt {
							t.Errorf("with the container %q, the Sieve tools %v and addendum %q, prompt =\n%s\nwant\n%s", c.container, sieveTools, addendum, prompt, wantPrompt)
						}
						if prompt.String() != prompt.System()+"\n\n"+prompt.Input() {
							t.Errorf("System() + Input() is not the whole prompt:\n%s\n---\n%s", prompt.System(), prompt.Input())
						}
						if got := strings.Contains(prompt.Input(), "# Addendum"); got != (addendum != "") {
							t.Errorf("addendum %q: Input() carries an Addendum layer: %v", addendum, got)
						}
						if strings.Contains(prompt.System(), "# Addendum") || !strings.HasSuffix(prompt.Input(), prompt.Data.String()) {
							t.Errorf("the addendum is not between the brief and the data, in the input alone:\n%s", prompt)
						}
						for _, tool := range tools {
							if said := strings.Contains(prompt.String(), tool); !sieveTools && said {
								t.Errorf("a run without the Sieve tools is told of %q", tool)
							}
						}
						if offered := strings.Contains(prompt.String(), "add_to_answer"); offered != (sieveTools && w.output == Content) {
							t.Errorf("with the Sieve tools %v, add_to_answer offered: %v", sieveTools, offered)
						}
					}
				}
			}
		})
	}
	if _, err := ps.Task("nope"); err == nil {
		t.Error("Task(nope) found a task")
	}
}

// A prompt's layers come in their fixed order, the empty ones left out, and the
// whole prompt is each of them under its heading.
func TestPrompt_LayersInOrderLeavingOutTheEmpty(t *testing.T) {
	p := Prompt{
		Data:       Layer{Heading: "# Data", Text: "the data\n"},
		Brief:      Layer{Heading: "# Brief", Text: " \n "},
		Background: Layer{Heading: "# Background", Text: "\nthe background"},
		Addendum:   Layer{Heading: "# Addendum", Text: "the addendum"},
	}
	var headings []string
	for _, l := range p.Layers() {
		headings = append(headings, l.Heading)
	}
	if got := strings.Join(headings, ", "); got != "# Background, # Addendum, # Data" {
		t.Errorf("layers = %s", got)
	}
	if want := "# Background\n\nthe background\n\n# Addendum\n\nthe addendum\n\n# Data\n\nthe data"; p.String() != want {
		t.Errorf("String() = %q, want %q", p.String(), want)
	}
	if want := "# Background\n\nthe background"; p.System() != want {
		t.Errorf("System() = %q, want %q", p.System(), want)
	}
	if want := "# Addendum\n\nthe addendum\n\n# Data\n\nthe data"; p.Input() != want {
		t.Errorf("Input() = %q, want %q", p.Input(), want)
	}
}

// Each task's data renders every value it is given, under its label, verbatim:
// a value holding text such as {history} reaches the prompt as written, and
// another value is never spliced into it.
func TestTaskData_RendersEveryValueVerbatim(t *testing.T) {
	ps, err := NewPromptService(newMockStore())
	if err != nil {
		t.Fatal(err)
	}
	const verbatim = "a note on {history}, {content} and {question}"
	day := func(d, h int) time.Time { return time.Date(2026, 11, d, h, 30, 0, 0, time.UTC) }
	for _, tc := range []struct {
		name string
		data TaskData
		want []string
	}{
		{"file", FilingData{Folders: []string{"Home", "Work"}, Now: day(27, 10), Created: day(1, 9), Modified: day(20, 18), FocusCount: 7, Version: 3, Content: verbatim},
			[]string{"Existing folders: Home, Work", "- Current Time: 2026-11-27T10:30:00Z", "- Created: 2026-11-01T09:30:00", "- Modified: 2026-11-20T18:30:00",
				"- Focus Signal: 7", "- Iteration: 3", "Content:\n" + verbatim}},
		{"file, with nothing known", FilingData{Content: verbatim},
			[]string{"Existing folders: (none yet)", "- Created: unknown", "- Modified: unknown", "- Focus Signal: 0", "- Iteration: 1"}},
		{"ask and explain", ThreadData{ContentType: "go", Content: verbatim, History: "the thread", Action: "the action {content}"},
			[]string{"Content type: go", "TARGET:\n" + verbatim, "THREAD:\nthe thread", "ACTION:\nthe action {content}"}},
		{"chat", ChatData{Turns: []ChatTurn{{Address: "sieve://c/e1", Text: verbatim}}, About: "the material {content}", Question: "the question {history}"},
			[]string{"THREAD:\n===== TURN 1 =====\nADDRESS: sieve://c/e1\n" + verbatim, "ABOUT:\nthe material {content}", "QUESTION:\nthe question {history}"}},
		{"btw", BtwData{Question: verbatim, Selection: "the selection", DocTitle: "My Doc", DocSummary: "a summary"},
			[]string{"QUESTION:\n" + verbatim, "SELECTED TEXT:\nthe selection", "- Document title: My Doc", "- Document summary: a summary"}},
		{"image", ImageData{File: "shot {content}.png"}, []string{"Image file: shot {content}.png"}},
		{"note-meta", NoteMetaData{Pages: []string{"page-b-2.png", "page-a-1.png"}, Categories: []string{"Home", "Work"}},
			[]string{"Page files:\n1. page-b-2.png\n2. page-a-1.png", "Categories: Home, Work"}},
		{"note-meta, with no categories", NoteMetaData{Pages: []string{"page-1.png"}}, []string{"Categories: (none)"}},
		{"chat-meta", ChatMetaData{Turns: []string{verbatim, "And a turn?\n\n**ANSWER:** One exchange."}, Categories: []string{"Home", "Work"}},
			[]string{"THREAD:\n===== TURN 1 =====\n" + verbatim + "\n\n===== TURN 2 =====\nAnd a turn?", "---\n---\n\nCategories: Home, Work"}},
		{"chat-meta, with no categories", ChatMetaData{Turns: []string{verbatim}}, []string{"Categories: (none)"}},
		{"page-transcript", PageTranscriptData{File: "page-p1-k1.png"}, []string{"Page file: page-p1-k1.png"}},
		{"refine", RefineData{Content: verbatim, CurrentLanguage: "go", DetectionMethod: "heuristic"},
			[]string{"- Current Language: go", "- Detection Method: heuristic", "Code:\n" + verbatim}},
		{"web-clip-fetch", WebClipFetchData{Source: "https://example.com/{history}"}, []string{"URL: https://example.com/{history}"}},
		{"web-clip-summarise", WebClipSummariseData{Source: "https://example.com", Document: verbatim},
			[]string{"URL: https://example.com", "Current document context:\n" + verbatim}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text := tc.data.Text()
			for _, want := range tc.want {
				if !strings.Contains(text, want) {
					t.Errorf("the data does not render %q:\n%s", want, text)
				}
			}
			prompt := ps.Prompt(Task{Brief: Layer{Heading: briefHeading, Text: "the brief"}}, tc.data, "", false)
			if prompt.Data != (Layer{Heading: dataHeading, Text: text}) || !strings.HasSuffix(prompt.String(), "# Data\n\n"+strings.TrimSpace(text)) {
				t.Errorf("the prompt does not end with the data verbatim:\n%s", prompt)
			}
		})
	}
}

// A chat's data prints THREAD, ABOUT and QUESTION in that order, a section only
// when it has content, each turn under its own number and address; a turn's
// printed text is the same whatever turns follow it.
func TestChatData_PrintsEachSectionOnlyWhenItHasContent(t *testing.T) {
	first := ChatTurn{Address: "sieve://c/e1", Text: "What is a chat?\n\n**ANSWER:** A list."}
	second := ChatTurn{Address: "sieve://c/e2", Text: "And a turn?\n\n**ANSWER:** One exchange."}
	printedFirst := "===== TURN 1 =====\nADDRESS: sieve://c/e1\n" + first.Text
	printedSecond := "===== TURN 2 =====\nADDRESS: sieve://c/e2\n" + second.Text
	const rule = "\n\n---\n---\n\n"
	for _, tc := range []struct {
		name string
		data ChatData
		want string
	}{
		{"a first question", ChatData{Question: "the question"}, "QUESTION:\nthe question"},
		{"a question about material", ChatData{About: "the block", Question: "the question"}, "ABOUT:\nthe block" + rule + "QUESTION:\nthe question"},
		{"a follow-up", ChatData{Turns: []ChatTurn{first}, About: "  ", Question: "the question"},
			"THREAD:\n" + printedFirst + rule + "QUESTION:\nthe question"},
		{"every section", ChatData{Turns: []ChatTurn{first, second}, About: "the block", Question: "the question"},
			"THREAD:\n" + printedFirst + "\n\n" + printedSecond + rule + "ABOUT:\nthe block" + rule + "QUESTION:\nthe question"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.data.Text(); got != tc.want {
				t.Errorf("Text() =\n%s\nwant\n%s", got, tc.want)
			}
		})
	}
}
