package requesthandlers

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"sieve/sieve/protocol"
)

// Every inbound word the registry carries must have a handler behind it on the
// channel it is registered for. The gate answers a registered-but-unserved frame
// with a refusal, so the gap is never silent — but it is still a word the
// contract publishes and the server cannot honour, and the generated AsyncAPI
// tells clients to speak it.
// Its COMPANION, which makes this a bijection rather than a one-way inclusion,
// is TestWS_EveryHandledFrameTypeIsRegistered in ws_dispatch_test.go: every
// dispatch-table key must be registered, inbound, on the channel that serves it.
// The two halves live apart because each sits beside the thing it walks.
func TestWS_EveryRegisteredInboundFrameIsServed(t *testing.T) {
	h := NewWsHandler(nil, NewWorkspaceBroadcast(nil))
	reg := protocol.NewRegistry()
	tables := map[protocol.Channel]map[string]frameHandler{
		protocol.ChannelDocument:  h.documentFrames,
		protocol.ChannelWorkspace: h.workspaceFrames,
	}
	for channel, handlers := range tables {
		for _, entry := range reg.FramesFor(channel, protocol.Inbound) {
			if _, served := handlers[entry.Type]; !served {
				t.Errorf("%s frame %q is registered inbound but no handler serves it", channel, entry.Type)
			}
		}
	}
}

// The outbound half of the same question. An emission is not something a test
// can enumerate by driving the server — no single run reaches every emission
// site — so the source itself is the evidence: which frame constructors
// sieve/protocol declares, and which of them the server calls.
type emissionScan struct {
	root        string
	constructor map[string]string // constructor name -> the frame type word it builds
	emitted     map[string]string // frame type word -> the file that emits it
}

func newEmissionScan(t *testing.T) *emissionScan {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("locate module root: %v", err)
	}
	s := &emissionScan{
		root:        root,
		constructor: map[string]string{},
		emitted:     map[string]string{},
	}
	s.readConstructors(t)
	s.readEmissions(t)
	return s
}

// readConstructors maps every New…Frame constructor to the frame type word it
// stamps, by finding the Type constant its body names. A constructor that names
// none, or more than one, is a shape this mapping cannot read — and a silent
// miss there would make the completeness checks vacuous, so it fails loudly.
func (s *emissionScan) readConstructors(t *testing.T) {
	t.Helper()
	dir := filepath.Join(s.root, "sieve", "protocol")
	fset := token.NewFileSet()
	files := []*ast.File{}
	for _, path := range s.goFilesIn(t, dir) {
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		files = append(files, file)
	}

	words := map[string]string{} // constant name -> wire word
	for _, file := range files {
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				value, ok := spec.(*ast.ValueSpec)
				if !ok || len(value.Names) != len(value.Values) {
					continue
				}
				for i, name := range value.Names {
					lit, ok := value.Values[i].(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING || !strings.HasPrefix(name.Name, "Type") {
						continue
					}
					word, err := strconv.Unquote(lit.Value)
					if err != nil {
						t.Fatalf("unquote %s: %v", name.Name, err)
					}
					words[name.Name] = word
				}
			}
		}
	}
	if len(words) == 0 {
		t.Fatal("no frame type constants found — the scan would pass vacuously")
	}

	for _, file := range files {
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || fn.Body == nil {
				continue
			}
			if !strings.HasPrefix(fn.Name.Name, "New") || !strings.HasSuffix(fn.Name.Name, "Frame") {
				continue
			}
			named := map[string]bool{}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if ident, ok := n.(*ast.Ident); ok {
					if word, isType := words[ident.Name]; isType {
						named[word] = true
					}
				}
				return true
			})
			if len(named) != 1 {
				t.Fatalf("%s names %d frame type constants; the emission scan can only read one", fn.Name.Name, len(named))
			}
			for word := range named {
				s.constructor[fn.Name.Name] = word
			}
		}
	}
	if len(s.constructor) == 0 {
		t.Fatal("no frame constructors found — the scan would pass vacuously")
	}
}

// readEmissions records every frame word the server builds, from every call to
// one of those constructors anywhere in the module outside the protocol package
// itself (where they are declared, not spoken).
func (s *emissionScan) readEmissions(t *testing.T) {
	t.Helper()
	protocolDir := filepath.Join(s.root, "sieve", "protocol")
	fset := token.NewFileSet()
	for _, path := range s.goFilesUnder(t, s.root) {
		if strings.HasPrefix(path, protocolDir+string(filepath.Separator)) {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		rel, _ := filepath.Rel(s.root, path)
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "protocol" {
				return true
			}
			if word, isConstructor := s.constructor[sel.Sel.Name]; isConstructor {
				s.emitted[word] = rel
			}
			return true
		})
	}
	if len(s.emitted) == 0 {
		t.Fatal("no frame emissions found — the scan would pass vacuously")
	}
}

func (s *emissionScan) goFilesIn(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatalf("list %s: %v", dir, err)
	}
	out := []string{}
	for _, path := range matches {
		if !strings.HasSuffix(path, "_test.go") {
			out = append(out, path)
		}
	}
	sort.Strings(out)
	return out
}

func (s *emissionScan) goFilesUnder(t *testing.T, root string) []string {
	t.Helper()
	skip := map[string]bool{".git": true, "node_modules": true, "build": true, ".superpowers": true}
	out := []string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skip[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	sort.Strings(out)
	return out
}

// The scan itself: the mapping is read out of source, so a heuristic that
// quietly stopped resolving constructors would make both completeness checks
// pass by finding nothing at all. These two are the ones a name alone cannot
// give — the failure constructor stamps the SAME word as the success one, and
// the unresolved mention answers on the resolved frame's word.
func TestWS_TheEmissionScanReadsConstructorsByTheWordTheyStamp(t *testing.T) {
	scan := newEmissionScan(t)
	for _, known := range []struct{ constructor, word string }{
		{"NewPasteFailedFrame", protocol.TypePasteAck},
		{"NewMentionUnresolvedFrame", protocol.TypeMentionResolved},
		{"NewExtractAckFrame", protocol.TypeExtractAck},
	} {
		if got := scan.constructor[known.constructor]; got != known.word {
			t.Errorf("%s builds %q, want %q", known.constructor, got, known.word)
		}
	}
}

// A registered outbound word nobody builds is dead vocabulary: the generated
// contract tells clients to expect a frame the server can never send.
func TestWS_EveryRegisteredOutboundFrameIsEmitted(t *testing.T) {
	scan := newEmissionScan(t)
	for _, entry := range protocol.NewRegistry().Frames() {
		if entry.Direction != protocol.Outbound {
			continue
		}
		if _, emitted := scan.emitted[entry.Type]; !emitted {
			t.Errorf("%s frame %q is registered outbound but nothing builds it", entry.Channel, entry.Type)
		}
	}
}

// And the reverse: a word the server builds but the registry does not carry is a
// frame no client is told about and no generated artifact describes.
func TestWS_EveryEmittedFrameIsRegisteredOutbound(t *testing.T) {
	scan := newEmissionScan(t)
	registered := map[string]bool{}
	for _, entry := range protocol.NewRegistry().Frames() {
		if entry.Direction == protocol.Outbound {
			registered[entry.Type] = true
		}
	}
	for word, file := range scan.emitted {
		if !registered[word] {
			t.Errorf("%s emits frame %q, which the registry carries on no channel", file, word)
		}
	}
}
