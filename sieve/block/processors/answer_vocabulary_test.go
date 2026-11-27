package processors

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/ink"
	"sieve/sieve/services"
)

// citedNote is the one note the vocabulary's resolver answers for: the address a
// reference card's example cites.
const citedNote = "sieve://0198c1a0-0001-7000-8000-000000000001"

// citedNodes resolves citedNote to a note and nothing else.
type citedNodes struct{}

func (citedNodes) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	if addr.String() != citedNote {
		return domain.NodeDescriptor{}, domain.ErrNodeNotFound
	}
	return domain.NodeDescriptor{URI: citedNote, Kind: "note", Title: "Auth design", Summary: "How tokens rotate."}, nil
}

// registerEveryKind registers every kind the composition root registers, so the
// vocabulary is read over the registry the app runs with, addresses resolving
// through citedNodes and assets kept in a real store, and returns a document of
// that store an answer can be held in.
func registerEveryKind(t *testing.T) string {
	t.Helper()
	resetRegistry()
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	svc := block.BlockServices{Nodes: citedNodes{}, State: darkState(), Documents: ds, Assets: services.NewAssetService(fs, "")}
	block.RegisterProcessor(NewDiagramProcessor(svc))
	block.RegisterProcessor(NewSmartImageProcessor(svc))
	block.RegisterProcessor(NewSmartCardProcessor(svc))
	block.RegisterProcessor(NewReferenceProcessor(svc))
	block.RegisterProcessor(NewWebClipBlockProcessor(svc))
	block.RegisterProcessor(NewLogProcessor(svc))
	block.RegisterProcessor(NewCodeBlockProcessor(svc))
	block.RegisterProcessor(ink.NewDigitalNoteKind())
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	t.Cleanup(resetRegistry)
	return doc.UUID()
}

// Prose, diagram, image, link card, reference, web clip, log and code are
// offered and nothing else. Every card's own example builds an element that is
// settled or that its kind declares a job for, which the engine runs once it
// lands; an example built from content is content its kind takes as a paste,
// and is not acquired here.
func TestAnswerVocabulary_EveryCardBuildsASettledElement(t *testing.T) {
	doc := registerEveryKind(t)
	reg := block.GlobalRegistry()

	var offered []string
	for _, card := range reg.AnswerCards() {
		offered = append(offered, card.ContentType)
		if card.Use == "" || len(card.Attrs) == 0 || len(card.Example) == 0 {
			t.Errorf("%s: a card must say when to use it, its attrs and an example: %+v", card.ContentType, card)
		}
		p := block.GetProcessor(strings.TrimPrefix(card.ContentType, "sieve/"))
		if source, err := p.(block.AnswerKind).AnswerSource(card.Example); err != nil || source.Entries != nil {
			if err != nil || !p.IsSupportedContent(source.Entries).Has(block.ActionPaste) {
				t.Errorf("%s: its example is not content its kind pastes: %+v, %v", card.ContentType, source.Entries, err)
			}
			continue
		}
		el, err := reg.BuildAnswerElement(doc, card.ContentType, card.Example)
		if err != nil {
			t.Errorf("%s: its own example is refused: %v", card.ContentType, err)
			continue
		}
		if el.Status() == block.BlockStatusPending && block.GetProcessor(el.Kind).DescribeJob(block.JobContext{Block: &el}) == nil {
			t.Errorf("%s: its example builds a PENDING element no job settles: %+v", card.ContentType, el.Attrs)
		}
	}
	if got := strings.Join(offered, ","); got != "sieve/prose,sieve/diagram,sieve/smart-image,sieve/smart-card,sieve/reference,sieve/web-clip,sieve/log,sieve/code" {
		t.Errorf("offered content types = %s, want prose, diagram, image, link card, reference, web clip, log and code", got)
	}
}

// pendingCode is a code kind whose fresh block is PENDING and that declares no
// job to settle it.
type pendingCode struct{ *CodeBlockProcessor }

func (pendingCode) DescribeJob(block.JobContext) *block.ProcessorJob { return nil }

func (p pendingCode) AnswerSource(attrs block.AnswerAttrs) (block.AnswerSource, error) {
	s, err := attrs.Strings("source", "language")
	if err != nil {
		return block.AnswerSource{}, err
	}
	return block.AnswerSource{Overrides: map[string]any{"source": s["source"]}}, nil
}

// A map is built through the kind's own processor, with a fresh identity and
// every key the server owns; a type that is not offered answers with the
// catalogue, and a map the kind refuses, content it cannot acquire, or a map
// that would build a PENDING block no job settles, answers with the kind's card.
// An image is acquired as a paste of its URL is, from a server standing in for
// the web, into the document the answer is in.
func TestAnswerVocabulary_BuildsThroughTheKindsProcessor(t *testing.T) {
	chart := testPNG(t, 4, 3)
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/chart.png":
			_, _ = w.Write(chart)
		case "/page.png":
			_, _ = w.Write([]byte("<html>not an image</html>"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer web.Close()
	for _, tc := range []struct {
		name        string
		pending     bool
		noDocument  bool
		contentType string
		attrs       map[string]any
		wantErr     []string
		wantAttrs   map[string]any
		wantFace    map[string]any
		wantAsset   string // the key of the asset the element's src names in the document
	}{
		{name: "prose", contentType: "sieve/prose", attrs: map[string]any{"content": "**Go** compiles."},
			wantAttrs: map[string]any{"content": "**Go** compiles.", "status": block.BlockStatusComplete}},
		{name: "code: the language is the author's word", contentType: "sieve/code", attrs: map[string]any{"source": "func main() {}", "language": "go"},
			wantAttrs: map[string]any{"source": "func main() {}", "language": "go", "detectionMethod": "manual", "status": block.BlockStatusComplete}},
		{name: "diagram: Mermaid, drawn", contentType: "sieve/diagram", attrs: map[string]any{"source": "graph TD\n  A --> B"},
			wantAttrs: map[string]any{"diagramType": "mermaid", "mode": "render", "status": block.BlockStatusComplete}},
		{name: "diagram: PlantUML lands waiting on its render job", contentType: "sieve/diagram", attrs: map[string]any{"source": "A -> B", "diagramType": "plantuml"},
			wantAttrs: map[string]any{"diagramType": "plantuml", "mode": "render", "status": block.BlockStatusPending}},
		{name: "diagram: an engine there is none of", contentType: "sieve/diagram", attrs: map[string]any{"source": "A -> B", "diagramType": "graphviz"},
			wantErr: []string{"sieve/diagram refused", "mermaid or plantuml"}},
		{name: "log: lands waiting on its parse job", contentType: "sieve/log", attrs: map[string]any{"source": "2026-11-26T10:00:02Z ERROR pool exhausted"},
			wantAttrs: map[string]any{"source": "2026-11-26T10:00:02Z ERROR pool exhausted", "status": block.BlockStatusPending}},
		{name: "link card: lands waiting on its fetch job", contentType: "sieve/smart-card", attrs: map[string]any{"href": "https://go.dev/doc/effective_go"},
			wantAttrs: map[string]any{"href": "https://go.dev/doc/effective_go", "status": block.BlockStatusPending}},
		{name: "link card: not a web address", contentType: "sieve/smart-card", attrs: map[string]any{"href": "go.dev"},
			wantErr: []string{"sieve/smart-card refused", "http or https"}},
		{name: "web clip: summarised by default, landing waiting on its job", contentType: "sieve/web-clip", attrs: map[string]any{"source": "https://go.dev/blog/go1.22"},
			wantAttrs: map[string]any{"source": "https://go.dev/blog/go1.22", "mode": "summarise", "status": block.BlockStatusPending}},
		{name: "web clip: fetched whole", contentType: "sieve/web-clip", attrs: map[string]any{"source": "https://go.dev/blog/go1.22", "mode": "fetch"},
			wantAttrs: map[string]any{"mode": "fetch", "status": block.BlockStatusPending}},
		{name: "web clip: not a web address", contentType: "sieve/web-clip", attrs: map[string]any{"source": "go.dev"},
			wantErr: []string{"sieve/web-clip refused", "http or https"}},
		{name: "web clip: a mode there is none of", contentType: "sieve/web-clip", attrs: map[string]any{"source": "https://go.dev", "mode": "archive"},
			wantErr: []string{"sieve/web-clip refused", "summarise or fetch"}},
		{name: "image: downloaded into the note, landing waiting on its describe job", contentType: "sieve/smart-image", attrs: map[string]any{"url": web.URL + "/chart.png"},
			wantAttrs: map[string]any{"width": "4", "height": "3", "status": block.BlockStatusPending}, wantAsset: "chart.png"},
		{name: "image: a URL that does not fetch", contentType: "sieve/smart-image", attrs: map[string]any{"url": web.URL + "/gone.png"},
			wantErr: []string{"sieve/smart-image refused", "download", "404"}},
		{name: "image: what is there is not an image", contentType: "sieve/smart-image", attrs: map[string]any{"url": web.URL + "/page.png"},
			wantErr: []string{"sieve/smart-image refused", "not an image"}},
		{name: "image: a URL that names no image", contentType: "sieve/smart-image", attrs: map[string]any{"url": web.URL + "/chart"},
			wantErr: []string{"sieve/smart-image refused", "not an image"}},
		{name: "image: not a web address", contentType: "sieve/smart-image", attrs: map[string]any{"url": "chart.png"},
			wantErr: []string{"sieve/smart-image refused", "http or https"}},
		{name: "image: an answer no document holds", noDocument: true, contentType: "sieve/smart-image", attrs: map[string]any{"url": web.URL + "/chart.png"},
			wantErr: []string{"sieve/smart-image refused", "no document"}},
		{name: "reference: born wearing its target's face", contentType: "sieve/reference", attrs: map[string]any{"uri": citedNote},
			wantAttrs: map[string]any{"uri": citedNote}, wantFace: map[string]any{"title": "Auth design", "mime": "sieve/note", "summary": "How tokens rotate."}},
		{name: "reference: an address nothing answers for", contentType: "sieve/reference", attrs: map[string]any{"uri": "sieve://0198c1a0-0001-7000-8000-000000000999"},
			wantErr: []string{"sieve/reference refused", "nothing answers", `"example"`}},
		{name: "reference: a relative address", contentType: "sieve/reference", attrs: map[string]any{"uri": "/0198c1a0-0001-7000-8000-000000000002"},
			wantErr: []string{"sieve/reference refused", "absolute"}},
		{name: "a registered kind that is not offered", contentType: "sieve/ai-block", attrs: map[string]any{"question": "why?"},
			wantErr: []string{`"sieve/ai-block"`, "sieve/prose", "sieve/code", "sieve/diagram", `"example"`}},
		{name: "not a sieve content type", contentType: "text/plain", attrs: map[string]any{"content": "x"},
			wantErr: []string{`"text/plain"`, "sieve/prose"}},
		{name: "a required attr missing", contentType: "sieve/code", attrs: map[string]any{"source": "x := 1"},
			wantErr: []string{"sieve/code refused", `"language"`, `"example"`}},
		{name: "a blank attr", contentType: "sieve/prose", attrs: map[string]any{"content": "  "},
			wantErr: []string{"sieve/prose refused", `"content"`}},
		{name: "a key the server owns", contentType: "sieve/prose", attrs: map[string]any{"content": "x", "id": "mine"},
			wantErr: []string{"sieve/prose refused", `"id"`}},
		{name: "a block that would wait on a job no kind runs", pending: true, contentType: "sieve/code", attrs: map[string]any{"source": "x := 1", "language": "go"},
			wantErr: []string{"sieve/code refused", "no job"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := registerEveryKind(t)
			if tc.pending {
				block.RegisterProcessor(pendingCode{NewCodeBlockProcessor(block.BlockServices{})})
			}
			container := doc
			if tc.noDocument {
				container = ""
			}
			el, err := block.GlobalRegistry().BuildAnswerElement(container, tc.contentType, tc.attrs)
			if tc.wantErr != nil {
				if err == nil {
					t.Fatalf("built %+v, want a refusal", el.Attrs)
				}
				for _, want := range tc.wantErr {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("refusal %q does not carry %s", err, want)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("refused: %v", err)
			}
			if el.Kind != strings.TrimPrefix(tc.contentType, "sieve/") || el.ID == "" || el.Attrs["id"] != el.ID {
				t.Errorf("element kind %q id %q / %v: want the content type's kind, identified on both sides", el.Kind, el.ID, el.Attrs["id"])
			}
			for k, want := range tc.wantAttrs {
				if el.Attrs[k] != want {
					t.Errorf("attr %s = %v, want %v", k, el.Attrs[k], want)
				}
			}
			if tc.wantAsset != "" && el.Attrs["src"] != "sieve://"+doc+"/"+tc.wantAsset {
				t.Errorf("src = %v, want the asset %s of the answer's document", el.Attrs["src"], tc.wantAsset)
			}
			for k, want := range tc.wantFace {
				if got := el.FaceString(k); got != want {
					t.Errorf("face %s = %q, want %v", k, got, want)
				}
			}
		})
	}
}
