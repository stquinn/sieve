// Package gen turns the wire contract into the artifacts that publish it: the
// human-readable reference, the two machine specs, and the JavaScript constants
// the browser half spells its frame words with.
//
// It has THREE sources and invents nothing outside them:
//
//   - protocol.Registry, by reflection — the vocabulary and the payload shapes.
//   - The source itself, by go/doc — every description, because the registry
//     deliberately holds no prose. A registered type with no godoc comment fails
//     generation, naming itself.
//   - The assembled chi router, by chi.Walk — the route inventory, so the
//     documented surface is the served one.
//
// Every ordering is explicit and nothing timestamped is written, so regenerating
// without changing the contract produces byte-identical files — which is what
// lets a test assert the committed artifacts are current.
package gen

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"sieve/sieve/protocol"
)

// Artifact paths, relative to the directory Generate writes into.
const (
	APIMarkdownPath = "docs/API.md"
	OpenAPIPath     = "docs/openapi.yaml"
	AsyncAPIPath    = "docs/asyncapi.yaml"
	ProtocolJSPath  = "frontend/src/static/generated/protocol.js"
)

// generatedBy is stamped at the top of every artifact. It names the command
// rather than a time or a toolchain: those would make two runs differ and turn
// the currency test into a false alarm.
const generatedBy = "tools/protocolgen"

// Generator renders the contract. Each artifact is a method, so an emitter can
// be exercised on its own against a small fixture contract.
type Generator struct {
	contract Contract
	docs     *DocIndex
	schemas  *SchemaSet
}

// New builds the generator over a checkout: it gathers the live contract, opens
// the module's source for godoc, and resolves every registered payload type to a
// schema — which is where an undocumented type is caught, before a single byte
// is written.
func New(m Module) (*Generator, error) {
	contract, err := NewContract()
	if err != nil {
		return nil, err
	}
	return NewFor(m, contract)
}

// NewFor builds the generator over a contract supplied by the caller. It is how
// the emitters are tested: a fixture contract with a handful of frames renders
// through exactly the code the real one does.
func NewFor(m Module, contract Contract) (*Generator, error) {
	docs := NewDocIndex(m)
	g := &Generator{
		contract: contract,
		docs:     docs,
		schemas:  NewSchemaSet(docs),
	}
	if err := g.resolve(); err != nil {
		return nil, err
	}
	return g, nil
}

// resolve walks every registered payload into the schema set. It runs once, up
// front, so a contract naming a type nothing documents fails before any artifact
// exists — a half-written docs/API.md is worse than none.
func (g *Generator) resolve() error {
	if g.contract.DeclaredIn != "" {
		if _, err := g.docs.Load(g.contract.DeclaredIn); err != nil {
			return err
		}
	}
	topics := make([]string, 0, len(g.contract.Topics))
	for _, t := range g.contract.Topics {
		topics = append(topics, string(t))
	}
	if len(topics) > 0 {
		g.schemas.Enumerate(reflect.TypeOf(protocol.Topic("")), topics)
	}

	for _, f := range g.contract.Frames {
		if f.Payload == nil {
			return fmt.Errorf("frame %q on the %s channel names no payload type", f.Type, f.Channel)
		}
		if _, err := g.schemas.Add(f.Payload); err != nil {
			return fmt.Errorf("frame %q on the %s channel: %w", f.Type, f.Channel, err)
		}
	}
	for _, e := range g.contract.Endpoints {
		for _, t := range []reflect.Type{e.Request, e.Response} {
			if t == nil {
				continue
			}
			if _, err := g.schemas.Add(t); err != nil {
				return fmt.Errorf("endpoint %s %s: %w", e.Method, e.Path, err)
			}
		}
	}

	if missing := g.schemas.Undocumented(); len(missing) > 0 {
		return fmt.Errorf(
			"the wire contract is not self-documenting — these registered types carry no godoc comment, "+
				"and the registry holds no prose to fall back on:\n  %s",
			strings.Join(missing, "\n  "))
	}
	return nil
}

// Generate writes all four artifacts under dir, creating directories as needed.
// It is the whole surface a caller needs: the command runs it against the
// checkout, and the currency test runs it against a temporary directory and
// diffs.
func (g *Generator) Generate(dir string) error {
	artifacts := []struct {
		path   string
		render func() ([]byte, error)
	}{
		{APIMarkdownPath, g.APIMarkdown},
		{OpenAPIPath, g.OpenAPI},
		{AsyncAPIPath, g.AsyncAPI},
		{ProtocolJSPath, g.ProtocolJS},
	}
	for _, a := range artifacts {
		body, err := a.render()
		if err != nil {
			return fmt.Errorf("%s: %w", a.path, err)
		}
		full := filepath.Join(dir, filepath.FromSlash(a.path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, body, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// frameDoc is the godoc of a frame's payload type — the frame's description,
// since the registry carries none.
func (g *Generator) frameDoc(f protocol.FrameEntry) string {
	return g.typeDoc(f.Payload)
}

func (g *Generator) typeDoc(t reflect.Type) string {
	if t == nil {
		return ""
	}
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return g.docs.Type(t.PkgPath(), t.Name())
}

// messageName is a frame's identifier inside the specs. It is channel-qualified
// because ping and pong ride BOTH wires: one message per (channel, type word) is
// what keeps a document ping from claiming to be a workspace one.
func (g *Generator) messageName(f protocol.FrameEntry) string {
	parts := strings.Split(f.Type, "-")
	name := string(f.Channel)
	for _, p := range parts {
		if p == "" {
			continue
		}
		name += strings.ToUpper(p[:1]) + p[1:]
	}
	return name
}

// correlationField is the payload key a reply is matched on, or "" when the
// frame is uncorrelated. Every payload has already resolved by the time an
// emitter runs, so a failure here cannot happen and an uncorrelated answer is
// the honest one. The two wires use different words — the document wire
// mints an opId per request, the workspace wire a correlationId per command —
// and the field's PRESENCE is the whole test, because a frame that carries one
// is exactly a frame that takes part in request/reply.
func (g *Generator) correlationField(f protocol.FrameEntry) string {
	fields, err := g.schemas.Fields(f.Payload)
	if err != nil {
		return ""
	}
	for _, field := range fields {
		if field.JSONName == "opId" || field.JSONName == "correlationId" {
			return field.JSONName
		}
	}
	return ""
}
