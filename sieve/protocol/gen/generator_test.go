package gen

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"sieve/sieve"
	"sieve/sieve/protocol"

	"gopkg.in/yaml.v3"
)

// testModule locates the checkout the tests read source from. Every test needs
// it: the generator's whole point is that it reads declarations.
func testModule(t *testing.T) Module {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	m, err := NewModule(cwd)
	if err != nil {
		t.Fatalf("NewModule: %v", err)
	}
	return m
}

func fixtureGenerator(t *testing.T) *Generator {
	t.Helper()
	g, err := NewFor(testModule(t), fixtureContract())
	if err != nil {
		t.Fatalf("NewFor: %v", err)
	}
	return g
}

// assertGolden compares an emitter's output with the committed expectation.
// Running with UPDATE_GOLDEN=1 rewrites them, which is the only sanctioned way
// to change one: a golden edited by hand asserts what its author wanted, not
// what the code does.
func assertGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with UPDATE_GOLDEN=1)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s drifted.\n--- want ---\n%s\n--- got ---\n%s", name, want, got)
	}
}

func TestAPIMarkdown_MatchesGolden(t *testing.T) {
	got, err := fixtureGenerator(t).APIMarkdown()
	if err != nil {
		t.Fatalf("APIMarkdown: %v", err)
	}
	assertGolden(t, "fixture-api.md", got)
}

func TestOpenAPI_MatchesGolden(t *testing.T) {
	got, err := fixtureGenerator(t).OpenAPI()
	if err != nil {
		t.Fatalf("OpenAPI: %v", err)
	}
	assertGolden(t, "fixture-openapi.yaml", got)
}

func TestAsyncAPI_MatchesGolden(t *testing.T) {
	got, err := fixtureGenerator(t).AsyncAPI()
	if err != nil {
		t.Fatalf("AsyncAPI: %v", err)
	}
	assertGolden(t, "fixture-asyncapi.yaml", got)
}

func TestProtocolJS_MatchesGolden(t *testing.T) {
	got, err := fixtureGenerator(t).ProtocolJS()
	if err != nil {
		t.Fatalf("ProtocolJS: %v", err)
	}
	assertGolden(t, "fixture-protocol.js", got)
}

// A type with no godoc comment fails generation, naming itself. The registry
// holds no prose, so an undescribed type is a piece of wire nothing in the
// repository explains — and silently emitting an empty description is how that
// becomes permanent.
func TestGenerator_RefusesAnUndocumentedType(t *testing.T) {
	contract := fixtureContract()
	contract.Frames = append(contract.Frames, protocol.FrameEntry{
		Channel:   protocol.ChannelDocument,
		Direction: protocol.Inbound,
		Type:      "undocumented",
		Payload:   reflect.TypeOf(FixtureUndocumentedFrame{}),
	})

	_, err := NewFor(testModule(t), contract)
	if err == nil {
		t.Fatal("generation succeeded with an undocumented payload type")
	}
	if !strings.Contains(err.Error(), "FixtureUndocumentedFrame") {
		t.Errorf("the failure must name the offending type, got: %v", err)
	}
}

// A frame naming a type from outside the module cannot be described, because the
// generator has no source to read its documentation from.
func TestGenerator_RefusesATypeItCannotRead(t *testing.T) {
	contract := fixtureContract()
	contract.Frames = append(contract.Frames, protocol.FrameEntry{
		Channel:   protocol.ChannelDocument,
		Direction: protocol.Inbound,
		Type:      "foreign",
		Payload:   reflect.TypeOf(testing.T{}),
	})

	_, err := NewFor(testModule(t), contract)
	if err == nil {
		t.Fatal("generation succeeded with a payload type from another module")
	}
	if !strings.Contains(err.Error(), "testing") {
		t.Errorf("the failure must name the foreign package, got: %v", err)
	}
}

// A channel with no route is a wire the artifacts would advertise an address for
// that nothing serves.
func TestGenerator_RefusesAChannelNothingServes(t *testing.T) {
	contract := fixtureContract()
	contract.Routes = []Route{{Method: "GET", Pattern: "/api/ws/workspace"}}

	g, err := NewFor(testModule(t), contract)
	if err != nil {
		t.Fatalf("NewFor: %v", err)
	}
	if _, err := g.APIMarkdown(); err == nil || !strings.Contains(err.Error(), "document") {
		t.Errorf("want a failure naming the unserved channel, got: %v", err)
	}
}

// Every artifact is byte-identical across runs. Without that, the test that
// keeps the committed artifacts current would fail on noise, and it would be
// silenced.
func TestGenerate_IsDeterministic(t *testing.T) {
	module := testModule(t)
	first, second := t.TempDir(), t.TempDir()

	for _, dir := range []string{first, second} {
		g, err := New(module)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if err := g.Generate(dir); err != nil {
			t.Fatalf("Generate: %v", err)
		}
	}

	for _, name := range []string{APIMarkdownPath, OpenAPIPath, AsyncAPIPath, ProtocolJSPath} {
		a, err := os.ReadFile(filepath.Join(first, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		b, err := os.ReadFile(filepath.Join(second, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if !bytes.Equal(a, b) {
			t.Errorf("%s differs between two runs of the same contract", name)
		}
		if len(a) == 0 {
			t.Errorf("%s is empty", name)
		}
	}
}

// The godoc walk must reach the packages the payloads REFERENCE, not just
// sieve/protocol: a block or domain type describes itself on its own
// declaration, and a walk that stopped short would either omit that description
// or fail the self-documentation rule on a type that is perfectly documented.
func TestGenerate_DocumentsReferencedPackages(t *testing.T) {
	g, err := New(testModule(t))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	markdown, err := g.APIMarkdown()
	if err != nil {
		t.Fatalf("APIMarkdown: %v", err)
	}

	// One sentence from each referenced package's own godoc, so the assertion
	// fails if the walk stops at protocol.
	for _, phrase := range []string{
		"PasteResult is what one paste did",
		"ContentEntry is one item from the browser clipboard",
		"FrontendBlock is the wire shape the WYSIWYG editor renders from",
		"BlockOp is a granular mutation of the BlockDoc tree",
		"SupportedActions is one processor's offer",
		"Candidate is one offer from a source's enumeration face",
		"Attachment is a live edge to another Node",
		"JobInfo describes one background job",
	} {
		if !bytes.Contains(markdown, []byte(phrase)) {
			t.Errorf("the reference is missing prose from a referenced package: %q", phrase)
		}
	}
}

// The command vocabulary is published WHOLE. Structurally it cannot drift —
// ServiceProvider.CommandSet is the one list, registered from by the composition
// root and enumerated from here — but "cannot drift" is worth an assertion,
// because an emitter that filtered, deduplicated or truncated the list would
// reintroduce exactly the silence this generator exists to remove: a verb the
// app dispatches and no artifact mentions.
func TestGenerate_PublishesEveryRegisteredCommand(t *testing.T) {
	registered := (&sieve.ServiceProvider{}).CommandSet()
	if len(registered) == 0 {
		t.Fatal("the app registers no commands: the shared list is not being read")
	}

	g, err := New(testModule(t))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if len(g.contract.Commands) != len(registered) {
		t.Fatalf("the contract carries %d commands, the app registers %d",
			len(g.contract.Commands), len(registered))
	}

	markdown, err := g.APIMarkdown()
	if err != nil {
		t.Fatalf("APIMarkdown: %v", err)
	}
	js, err := g.ProtocolJS()
	if err != nil {
		t.Fatalf("ProtocolJS: %v", err)
	}
	for _, cmd := range registered {
		for _, artifact := range []struct {
			name string
			body []byte
		}{{APIMarkdownPath, markdown}, {ProtocolJSPath, js}} {
			if !bytes.Contains(artifact.body, []byte("'"+cmd.Name()+"'")) &&
				!bytes.Contains(artifact.body, []byte("`/"+cmd.Name()+"`")) {
				t.Errorf("/%s is registered but %s never names it", cmd.Name(), artifact.name)
			}
		}
		if !bytes.Contains(js, []byte("'"+cmd.Family()+"'")) {
			t.Errorf("/%s is in the %q family, which %s never names",
				cmd.Name(), cmd.Family(), ProtocolJSPath)
		}
	}
}

// The committed artifacts are the published contract, and a stale one publishes
// a wire nobody speaks. This is the loud failure that catches the whole class:
// a frame, endpoint, topic or command added to Go without a regeneration fails
// here, naming the artifact, rather than being noticed by a reader months later.
//
// Regenerate with: nix develop -c env CGO_ENABLED=0 go generate ./sieve/protocol
func TestGenerate_CommittedArtifactsAreCurrent(t *testing.T) {
	module := testModule(t)
	g, err := New(module)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	fresh := t.TempDir()
	if err := g.Generate(fresh); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	for _, name := range []string{APIMarkdownPath, OpenAPIPath, AsyncAPIPath, ProtocolJSPath} {
		want, err := os.ReadFile(filepath.Join(fresh, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read generated %s: %v", name, err)
		}
		got, err := os.ReadFile(filepath.Join(module.Root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read committed %s: %v", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s is stale — the contract changed and the artifact was not regenerated "+
				"(nix develop -c env CGO_ENABLED=0 go generate ./sieve/protocol)", name)
		}
	}
}

// Every component the HTTP spec ships must be referenced by something in it, and
// must describe a message that actually exists. A request whose fields are split
// between the query string and the body is the trap: its component would say the
// query parameter is a required body property, contradicting the operation that
// would have referenced it — so it earns no component and its body is inline.
func TestOpenAPI_ComponentsAreReferencedAndTruthful(t *testing.T) {
	spec, err := fixtureGenerator(t).OpenAPI()
	if err != nil {
		t.Fatalf("OpenAPI: %v", err)
	}
	var doc struct {
		Components struct {
			Schemas map[string]yaml.Node `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(spec, &doc); err != nil {
		t.Fatalf("the spec is not YAML: %v", err)
	}
	if len(doc.Components.Schemas) == 0 {
		t.Fatal("the spec ships no components at all")
	}
	for name := range doc.Components.Schemas {
		if !bytes.Contains(spec, []byte("$ref: '#/components/schemas/"+name+"'")) {
			t.Errorf("component %s is emitted but nothing references it", name)
		}
	}
	if _, unwanted := doc.Components.Schemas["GenFixturePatchRequest"]; unwanted {
		t.Error("the split request earned a component, which contradicts its own operation")
	}
	if _, wanted := doc.Components.Schemas["GenFixtureCreateRequest"]; !wanted {
		t.Error("the unsplit request earned no component, so its operation has nothing to reference")
	}
}

// An operation whose handler content-negotiates advertises BOTH encodings. The
// registry records that on the endpoint; a spec that mentioned only JSON would
// tell a form-posting client its request is unsupported.
func TestOpenAPI_AdvertisesEveryEncodingAnOperationAccepts(t *testing.T) {
	spec, err := fixtureGenerator(t).OpenAPI()
	if err != nil {
		t.Fatalf("OpenAPI: %v", err)
	}
	if !bytes.Contains(spec, []byte("application/x-www-form-urlencoded")) {
		t.Error("the form-accepting operation advertises only JSON")
	}
	if bytes.Count(spec, []byte("application/x-www-form-urlencoded")) != 1 {
		t.Error("an operation that does not accept a form advertises one")
	}
}

// A constant's documentation is indexed against its VALUE, because the wire
// carries the value: the artifacts describe the topic "notes", never the
// identifier TopicNotes.
func TestDocIndex_DescribesConstantsByValue(t *testing.T) {
	docs := NewDocIndex(testModule(t))
	pkg := reflect.TypeOf(protocol.PingFrame{}).PkgPath()
	if _, err := docs.Load(pkg); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := docs.ConstValue(pkg, string(protocol.TopicNotes)); got == "" {
		t.Errorf("topic %q has no description", protocol.TopicNotes)
	}
	if got := docs.Type(pkg, "Topic"); got == "" {
		t.Error("the Topic type has no godoc")
	}
}
