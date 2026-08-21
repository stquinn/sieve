package gen

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Module is the checkout the generator reads from: where the source lives and
// what import path its root carries. Generation needs BOTH — reflection hands
// back import paths ("sieve/sieve/block") and go/ast needs directories, so the
// two are converted into each other constantly.
type Module struct {
	Root string // absolute path of the directory holding go.mod
	Path string // the module directive's import path
}

// NewModule locates the module containing dir by walking up for a go.mod. The
// generator runs from wherever `go generate` or a test puts it, so the checkout
// is discovered rather than assumed.
func NewModule(dir string) (Module, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Module{}, err
	}
	for {
		gomod := filepath.Join(abs, "go.mod")
		if data, err := os.ReadFile(gomod); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if path, ok := strings.CutPrefix(strings.TrimSpace(line), "module "); ok {
					return Module{Root: abs, Path: strings.TrimSpace(path)}, nil
				}
			}
			return Module{}, fmt.Errorf("%s: no module directive", gomod)
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return Module{}, fmt.Errorf("no go.mod found at or above %s", dir)
		}
		abs = parent
	}
}

// Dir returns the directory holding the package with this import path, and
// false when the path belongs to another module — the standard library, or a
// dependency — whose source this generator does not read.
func (m Module) Dir(importPath string) (string, bool) {
	if importPath == m.Path {
		return m.Root, true
	}
	rel, ok := strings.CutPrefix(importPath, m.Path+"/")
	if !ok {
		return "", false
	}
	return filepath.Join(m.Root, filepath.FromSlash(rel)), true
}
