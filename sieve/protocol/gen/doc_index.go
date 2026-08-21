package gen

import (
	"fmt"
	"go/ast"
	"go/doc"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DocIndex is the generator's PROSE source. The Registry deliberately holds no
// descriptions — a contract is described where it is declared — so every
// sentence in the generated artifacts is a godoc comment read back out of the
// source here.
//
// It indexes whatever packages it is asked for, which must include every package
// a registered payload REFERENCES and not only sieve/protocol itself: a
// block.PasteResult or a domain.JobInfo carries its description on its own
// declaration, and a walk that stopped at protocol would report those types as
// undescribed and fail the self-documentation rule spuriously.
type DocIndex struct {
	module Module
	types  map[string]string // "import/path.TypeName" -> godoc
	pkgs   map[string]string // import path -> package godoc
	consts map[string]string // "import/path\x00value"  -> godoc of the constant holding that value
	loaded map[string]bool   // import paths already read
}

// NewDocIndex opens an empty index over m. Packages are read on demand by Load.
func NewDocIndex(m Module) *DocIndex {
	return &DocIndex{
		module: m,
		types:  map[string]string{},
		pkgs:   map[string]string{},
		consts: map[string]string{},
		loaded: map[string]bool{},
	}
}

// Load reads one package's declarations. A package outside the module (the
// standard library, a dependency) has no source this generator reads and is
// reported as not loaded rather than as an error — the caller decides whether a
// type from there is admissible.
func (d *DocIndex) Load(importPath string) (bool, error) {
	if d.loaded[importPath] {
		return true, nil
	}
	dir, ok := d.module.Dir(importPath)
	if !ok {
		return false, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", dir, err)
	}
	// Files are sorted by ReadDir, so the AST — and every doc string read off it
	// — is assembled in the same order on every run.
	fset := token.NewFileSet()
	var files []*ast.File
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") {
			continue
		}
		path := filepath.Join(dir, name)
		src, err := os.ReadFile(path)
		if err != nil {
			return false, fmt.Errorf("read %s: %w", path, err)
		}
		// go/doc reads a _test.go file for EXAMPLES only, so a type declared in one
		// would be invisible — and the emitter fixtures declare theirs there
		// precisely so they are not production code. The bytes are untouched; only
		// the name go/doc sees them under is.
		parsed := path
		if strings.HasSuffix(name, "_test.go") {
			parsed = strings.TrimSuffix(path, "_test.go") + "_testdecls.go"
		}
		f, err := parser.ParseFile(fset, parsed, src, parser.ParseComments)
		if err != nil {
			return false, fmt.Errorf("parse %s: %w", path, err)
		}
		// A directory may hold an external test package alongside the real one;
		// the contract is only ever declared in the latter.
		if strings.HasSuffix(f.Name.Name, "_test") {
			continue
		}
		files = append(files, f)
	}

	pkg, err := doc.NewFromFiles(fset, files, importPath, doc.AllDecls|doc.PreserveAST)
	if err != nil {
		return false, fmt.Errorf("document %s: %w", dir, err)
	}
	d.index(importPath, pkg)
	d.loaded[importPath] = true
	return true, nil
}

func (d *DocIndex) index(importPath string, p *doc.Package) {
	d.pkgs[importPath] = strings.TrimSpace(p.Doc)
	for _, t := range p.Types {
		d.types[importPath+"."+t.Name] = strings.TrimSpace(t.Doc)
		d.indexValues(importPath, t.Consts)
	}
	d.indexValues(importPath, p.Consts)
}

// indexValues records each constant's doc AGAINST ITS VALUE, because that is
// what the wire carries: the artifacts describe the topic "notes", never the
// identifier TopicNotes. A constant whose own line carries the comment (the
// house style for a vocabulary block) keeps it in the spec's trailing comment,
// so both positions are read.
func (d *DocIndex) indexValues(importPath string, values []*doc.Value) {
	for _, v := range values {
		for _, spec := range v.Decl.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			text := strings.TrimSpace(vs.Doc.Text())
			if text == "" {
				text = strings.TrimSpace(vs.Comment.Text())
			}
			if text == "" {
				text = strings.TrimSpace(v.Doc)
			}
			if text == "" {
				continue
			}
			for _, val := range vs.Values {
				lit, ok := val.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				unquoted, err := strconv.Unquote(lit.Value)
				if err != nil {
					continue
				}
				key := importPath + "\x00" + unquoted
				if _, exists := d.consts[key]; !exists {
					d.consts[key] = text
				}
			}
		}
	}
}

// Type returns a type's godoc. Absent and empty are the same answer: a type
// declared without a comment is a type with nothing to say about itself, and the
// generator refuses either.
func (d *DocIndex) Type(importPath, name string) string {
	return d.types[importPath+"."+name]
}

// Package returns a package's own godoc — the contract's opening statement,
// written where the rules it states are enforced.
func (d *DocIndex) Package(importPath string) string { return d.pkgs[importPath] }

// ConstValue returns the godoc of the constant in importPath whose value is
// value, or "" when nothing declares it.
func (d *DocIndex) ConstValue(importPath, value string) string {
	return d.consts[importPath+"\x00"+value]
}

// Summary is a doc comment's first sentence — what a table cell can hold. The
// full comment goes in the reference section beneath it.
func (d *DocIndex) Summary(godoc string) string {
	first := strings.TrimSpace(strings.Split(godoc, "\n\n")[0])
	first = strings.ReplaceAll(first, "\n", " ")
	if idx := strings.Index(first, ". "); idx >= 0 {
		first = first[:idx+1]
	}
	return strings.Join(strings.Fields(first), " ")
}
