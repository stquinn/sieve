package requesthandlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"sieve/sieve/protocol"
)

// openAPIContract is the committed docs/openapi.yaml as a test reads it. The
// generated spec is what other programs are told to expect; these tests answer
// the question generation alone cannot — whether the running handlers agree with
// it. Generation is checked against the registry in sieve/protocol/gen; this is
// checked against real responses.
type openAPIContract struct {
	Paths      map[string]map[string]openAPIOperation `yaml:"paths"`
	Components struct {
		Schemas map[string]map[string]interface{} `yaml:"schemas"`
	} `yaml:"components"`
}

type openAPIOperation struct {
	Responses map[string]struct {
		Content map[string]struct {
			Schema map[string]interface{} `yaml:"schema"`
		} `yaml:"content"`
	} `yaml:"responses"`
}

func loadOpenAPIContract(t *testing.T) openAPIContract {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "docs", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read the committed spec: %v", err)
	}
	var contract openAPIContract
	if err := yaml.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("the committed spec is not YAML: %v", err)
	}
	if len(contract.Paths) == 0 {
		t.Fatal("the committed spec describes no operations")
	}
	return contract
}

// responseSchema is what the spec promises a 200 looks like in one media type.
// A missing promise fails here rather than letting a validation pass vacuously.
func (c openAPIContract) responseSchema(t *testing.T, method, path, media string) map[string]interface{} {
	t.Helper()
	operations, ok := c.Paths[path]
	if !ok {
		t.Fatalf("the spec describes no path %s", path)
	}
	operation, ok := operations[strings.ToLower(method)]
	if !ok {
		t.Fatalf("the spec describes no %s on %s", method, path)
	}
	response, ok := operation.Responses["200"]
	if !ok {
		t.Fatalf("%s %s publishes no 200 response", method, path)
	}
	content, ok := response.Content[media]
	if !ok {
		t.Fatalf("%s %s publishes no %s response body", method, path, media)
	}
	if len(content.Schema) == 0 {
		t.Fatalf("%s %s publishes a %s body with no schema", method, path, media)
	}
	return content.Schema
}

// mediaTypes is every content type the spec says a 200 can arrive in.
func (c openAPIContract) mediaTypes(t *testing.T, method, path string) []string {
	t.Helper()
	operation, ok := c.Paths[path][strings.ToLower(method)]
	if !ok {
		t.Fatalf("the spec describes no %s on %s", method, path)
	}
	media := []string{}
	for name := range operation.Responses["200"].Content {
		media = append(media, name)
	}
	return media
}

// problems lists every way one decoded JSON value fails the schema the spec
// publishes for it, empty when the answer is exactly what was promised. It
// answers in a slice rather than reporting through *testing.T so that the
// checker itself is testable: a validator that silently accepts everything
// passes every contract test it is pointed at.
//
// It is deliberately strict about UNDECLARED properties: both halves come from
// the same Go type, so a field in the answer the spec does not describe means
// the response drifted away from the type the contract documents.
func (c openAPIContract) problems(where string, schema map[string]interface{}, value interface{}) []string {
	schema, unresolved := c.resolve(where, schema)
	if unresolved != "" {
		return []string{unresolved}
	}
	found := []string{}
	declared, _ := schema["type"].(string)

	switch declared {
	case "object":
		object, ok := value.(map[string]interface{})
		if !ok {
			return []string{fmt.Sprintf("%s: spec says object, answer has %T", where, value)}
		}
		for _, name := range c.requiredOf(schema) {
			if _, present := object[name]; !present {
				found = append(found, fmt.Sprintf("%s: required property %q is missing from the answer", where, name))
			}
		}
		properties, _ := schema["properties"].(map[string]interface{})
		if len(properties) == 0 {
			return found // a free-form object: the spec promises nothing about its keys
		}
		for name, field := range object {
			property, described := properties[name]
			if !described {
				found = append(found, fmt.Sprintf("%s: the answer carries %q, which the spec does not describe", where, name))
				continue
			}
			propertySchema, ok := property.(map[string]interface{})
			if !ok {
				found = append(found, fmt.Sprintf("%s: property %q has no schema in the spec", where, name))
				continue
			}
			found = append(found, c.problems(where+"."+name, propertySchema, field)...)
		}
	case "array":
		if value == nil {
			return found // an absent list is the zero value, not a shape violation
		}
		items, ok := value.([]interface{})
		if !ok {
			return []string{fmt.Sprintf("%s: spec says array, answer has %T", where, value)}
		}
		itemSchema, ok := schema["items"].(map[string]interface{})
		if !ok {
			return []string{fmt.Sprintf("%s: the spec's array declares no item schema", where)}
		}
		for i, item := range items {
			found = append(found, c.problems(fmt.Sprintf("%s[%d]", where, i), itemSchema, item)...)
		}
	case "string":
		if _, ok := value.(string); !ok && value != nil {
			found = append(found, fmt.Sprintf("%s: spec says string, answer has %T", where, value))
		}
	case "integer", "number":
		if _, ok := value.(float64); !ok && value != nil {
			found = append(found, fmt.Sprintf("%s: spec says %s, answer has %T", where, declared, value))
		}
	case "boolean":
		if _, ok := value.(bool); !ok && value != nil {
			found = append(found, fmt.Sprintf("%s: spec says boolean, answer has %T", where, value))
		}
	}
	return found
}

// resolve follows a $ref into the components section, which is where every
// shape big enough to be shared is described. A ref the spec cannot answer is
// returned as a problem, not a panic: it is a defect in the contract itself.
func (c openAPIContract) resolve(where string, schema map[string]interface{}) (map[string]interface{}, string) {
	ref, isRef := schema["$ref"].(string)
	if !isRef {
		return schema, ""
	}
	name := strings.TrimPrefix(ref, "#/components/schemas/")
	component, ok := c.Components.Schemas[name]
	if !ok {
		return nil, fmt.Sprintf("%s: the spec references component %s, which it does not ship", where, name)
	}
	return component, ""
}

// validate reports every problem as a test failure.
func (c openAPIContract) validate(t *testing.T, where string, schema map[string]interface{}, value interface{}) {
	t.Helper()
	for _, problem := range c.problems(where, schema, value) {
		t.Error(problem)
	}
}

func (c openAPIContract) requiredOf(schema map[string]interface{}) []string {
	required, _ := schema["required"].([]interface{})
	names := []string{}
	for _, name := range required {
		if text, ok := name.(string); ok {
			names = append(names, text)
		}
	}
	return names
}

// answer sends one request and returns what a client would see: status, the
// media type it arrived in, and the body.
func answer(t *testing.T, method, url, contentType, body string) (int, string, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("Content-Type"), string(raw)
}

// The load half's real answer must be the DocumentContent the spec publishes —
// every required field present, every field described, and no field the spec
// does not know about.
func TestOpenAPI_DocumentLoadAnswersWhatItPublishes(t *testing.T) {
	contract := loadOpenAPIContract(t)
	srv, sp, _, _ := newDocumentEndpointServer(t)
	if err := sp.Prompts.SavePrompt("ask", "answer the question"); err != nil {
		t.Fatalf("SavePrompt: %v", err)
	}

	status, media, body := answer(t, http.MethodGet, srv.URL+"/api/document/load?uuid=prompt:ask", "", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d (%s)", status, body)
	}
	if !strings.HasPrefix(media, "application/json") {
		t.Errorf("content type = %q, want the application/json the spec publishes", media)
	}
	var decoded interface{}
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("the answer is not JSON: %v", err)
	}
	contract.validate(t, "DocumentContent",
		contract.responseSchema(t, http.MethodGet, "/api/document/load", "application/json"), decoded)
}

// The write half likewise: a save answers the version it produced, and the spec
// says so.
func TestOpenAPI_DocumentSaveAnswersWhatItPublishes(t *testing.T) {
	contract := loadOpenAPIContract(t)
	srv, _, _, _ := newDocumentEndpointServer(t)

	status, media, body := answer(t, http.MethodPost, srv.URL+"/api/document/save?uuid=prompt:ask",
		"application/json", `{"body":"a new instruction","mode":"markdown"}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d (%s)", status, body)
	}
	if !strings.HasPrefix(media, "application/json") {
		t.Errorf("content type = %q, want the application/json the spec publishes", media)
	}
	var decoded interface{}
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("the answer is not JSON: %v", err)
	}
	contract.validate(t, "DocumentSaveResponse",
		contract.responseSchema(t, http.MethodPost, "/api/document/save", "application/json"), decoded)
}

// The note and folder operations answer HYPERMEDIA, and their entries say so.
// The check is the one a client would make: the spec publishes text/html for
// them, and the running handler really answers in it — a JSON body arriving
// where the spec promised a fragment would break every HTMX swap that consumes
// it while the spec still read as correct.
func TestOpenAPI_FragmentOperationsAnswerTheMediaTypeTheyPublish(t *testing.T) {
	contract := loadOpenAPIContract(t)
	srv, sp := newItemServer(t)

	doc, err := sp.Documents.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc, err = sp.Documents.Save(doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if status, _, body := answer(t, http.MethodPost, srv.URL+"/api/folder", "application/json", `{"name":"Ideas"}`); status != http.StatusOK {
		t.Fatalf("folder create status %d: %s", status, body)
	}
	folder := folderID(t, sp, "Ideas")
	if folder == "" {
		t.Fatal("the created folder is not in the tree")
	}

	for _, call := range []struct {
		method, pattern, url, contentType, body string
	}{
		{http.MethodPatch, "/api/note/{id}", srv.URL + "/api/note/" + doc.UUID(), "application/json", `{"name":"Renamed"}`},
		{http.MethodPost, "/api/folder", srv.URL + "/api/folder", "application/x-www-form-urlencoded", "name=From+Form"},
		{http.MethodPatch, "/api/folder/{id}", srv.URL + "/api/folder/" + folder, "application/json", `{"name":"Later"}`},
		{http.MethodPost, "/api/tabs/close", srv.URL + "/api/tabs/close", "application/json", `{"ids":[]}`},
	} {
		t.Run(call.method+" "+call.pattern, func(t *testing.T) {
			entry, registered := protocol.NewRegistry().Endpoint(call.method, call.pattern)
			if !registered {
				t.Fatalf("%s %s is not in the registry", call.method, call.pattern)
			}
			if entry.ResponseKind != protocol.ResponseFragment {
				t.Fatalf("%s %s is registered as %s, not a fragment", call.method, call.pattern, entry.ResponseKind)
			}
			if media := contract.mediaTypes(t, call.method, call.pattern); len(media) != 1 || media[0] != "text/html" {
				t.Fatalf("the spec publishes %v for %s %s, want only text/html", media, call.method, call.pattern)
			}

			status, media, body := answer(t, call.method, call.url, call.contentType, call.body)
			if status != http.StatusOK {
				t.Fatalf("status = %d (%s)", status, body)
			}
			if !strings.HasPrefix(media, "text/html") {
				t.Errorf("content type = %q, want the text/html the spec publishes", media)
			}
		})
	}
}

// The checker itself, against the real DocumentContent schema: an answer that
// drops a promised field or grows one nobody published must be REPORTED. A
// validator that accepts everything passes every contract test above while
// proving nothing.
func TestOpenAPI_ValidatorCatchesADriftedAnswer(t *testing.T) {
	contract := loadOpenAPIContract(t)
	schema := contract.responseSchema(t, http.MethodGet, "/api/document/load", "application/json")

	for _, drift := range []struct {
		name   string
		answer map[string]interface{}
		want   string
	}{
		{
			name:   "a promised field is gone",
			answer: map[string]interface{}{"body": "x", "uuid": "prompt:ask", "scroll": float64(0)},
			want:   `required property "mode" is missing`,
		},
		{
			name: "a field nobody published appeared",
			answer: map[string]interface{}{
				"body": "x", "mode": "markdown", "uuid": "prompt:ask", "scroll": float64(0),
				"surprise": "not in the spec",
			},
			want: `the answer carries "surprise"`,
		},
		{
			name: "a field changed type",
			answer: map[string]interface{}{
				"body": "x", "mode": "markdown", "uuid": "prompt:ask", "scroll": "not a number",
			},
			want: "spec says integer",
		},
		{
			name: "a referenced component's items drifted",
			answer: map[string]interface{}{
				"body": "x", "mode": "wysiwyg", "uuid": "prompt:ask", "scroll": float64(0),
				"blocks": []interface{}{map[string]interface{}{"id": "b1"}},
			},
			want: `required property "kind" is missing`,
		},
	} {
		t.Run(drift.name, func(t *testing.T) {
			problems := contract.problems("DocumentContent", schema, drift.answer)
			if !strings.Contains(strings.Join(problems, "\n"), drift.want) {
				t.Errorf("problems = %v, want one naming %q", problems, drift.want)
			}
		})
	}
}

// Whichever kind an endpoint's answer IS, the spec must publish that kind for
// it: a registered endpoint the spec describes in another media type would send
// a client to the wrong parser.
func TestOpenAPI_PublishesEveryRegisteredEndpointInItsDeclaredKind(t *testing.T) {
	contract := loadOpenAPIContract(t)
	want := map[protocol.ResponseKind]string{
		protocol.ResponseJSON:     "application/json",
		protocol.ResponseFragment: "text/html",
	}
	for _, entry := range protocol.NewRegistry().Endpoints() {
		media, published := want[entry.ResponseKind]
		if !published {
			continue // a 204 or an unread body has no shape to publish
		}
		if got := contract.mediaTypes(t, entry.Method, entry.Path); len(got) != 1 || got[0] != media {
			t.Errorf("%s %s answers %s, but the spec publishes %v",
				entry.Method, entry.Path, entry.ResponseKind, got)
		}
	}
}
