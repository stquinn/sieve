package radio

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const radioPackage = "sieve/ink/radio"

// bluetoothLibraries are importable only by the radio package.
var bluetoothLibraries = []string{"tinygo.org/x/bluetooth", "github.com/tinygo-org/cbgo"}

// moduleTree is the module's source tree: its root directory and module path.
type moduleTree struct {
	root string
	path string
}

// findModuleTree walks up from the working directory to go.mod.
func findModuleTree(t *testing.T) moduleTree {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		data, err := os.ReadFile(filepath.Join(dir, "go.mod"))
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if rest, ok := strings.CutPrefix(line, "module "); ok {
					return moduleTree{root: dir, path: strings.TrimSpace(rest)}
				}
			}
			t.Fatalf("%s/go.mod names no module", dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no go.mod above the working directory")
		}
		dir = parent
	}
}

// imports maps each package's import path to the paths its Go files import,
// whatever their build tags.
func (m moduleTree) imports(t *testing.T) map[string][]string {
	t.Helper()
	found := map[string][]string{}
	err := filepath.WalkDir(m.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if path != m.root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "frontend") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			t.Errorf("parse %s: %v", path, err)
			return nil
		}
		rel, _ := filepath.Rel(m.root, filepath.Dir(path))
		pkg := m.path
		if rel != "." {
			pkg += "/" + filepath.ToSlash(rel)
		}
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err == nil {
				found[pkg] = append(found[pkg], imported)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestImportWalls(t *testing.T) {
	tree := findModuleTree(t)
	imports := tree.imports(t)
	if len(imports) == 0 {
		t.Fatal("no packages found")
	}
	for pkg, imported := range imports {
		for _, path := range imported {
			for _, library := range bluetoothLibraries {
				if (path == library || strings.HasPrefix(path, library+"/")) && pkg != tree.path+"/"+radioPackage {
					t.Errorf("package %s imports %s; only %s may", pkg, path, tree.path+"/"+radioPackage)
				}
			}
			if pkg == tree.path+"/sieve/ink/link" && (path == tree.path || strings.HasPrefix(path, tree.path+"/")) {
				t.Errorf("package %s imports %s; the link protocol imports nothing from this module", pkg, path)
			}
		}
	}
}
