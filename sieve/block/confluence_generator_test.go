package block

import (
	"testing"

	"github.com/yuin/goldmark/ast"
)

// transpile runs prose markdown through a fresh generator and returns the wiki
// markup and the fallback hits it took.
func transpile(md string) (string, int) {
	g := NewConfluenceGenerator()
	out := g.RenderBlock(SieveBlock{Kind: "prose"}, md)
	return out, g.Fallbacks()
}

// One row per line of the transpiler's mapping: markdown in, wiki markup out.
func TestConfluenceGenerator_Transpile(t *testing.T) {
	cases := []struct {
		name, md, want string
		fallbacks      int
	}{
		{"document joins blocks with a blank line", "one\n\ntwo", "one\n\ntwo", 0},
		{"soft break is a space", "one\ntwo", "one two", 0},
		{"hard break", "one\\\ntwo", `one\\two`, 0},
		{"heading", "### Third", "h3. Third", 0},
		{"setext heading", "Title\n=====", "h1. Title", 0},
		{"thematic break", "---", "----", 0},
		{"fence with a listed language", "```golang\nx := 1\n```", "{code:language=go}\nx := 1\n{code}", 0},
		{"fence with an unlisted language", "```cobolish\nx\n```", "{code}\nx\n{code}", 0},
		{"fence without a language", "```\nx\n```", "{code}\nx\n{code}", 0},
		{"plantuml fence", "```plantuml\n@startuml\nA -> B\n@enduml\n```", "{plantuml}\n@startuml\nA -> B\n@enduml\n{plantuml}", 0},
		{"mermaid fence", "```mermaid\ngraph LR; A-->B\n```", "{code}\ngraph LR; A-->B\n{code}", 0},
		{"indented code", "    x := 1\n    y := 2", "{code}\nx := 1\ny := 2\n{code}", 0},
		{"blockquote", "> one\n>\n> two", "{quote}\none\n\ntwo\n{quote}", 0},
		{"nested bullets", "- a\n  - b\n    - c\n- d", "* a\n** b\n*** c\n* d", 0},
		{"bullet under a number", "1. a\n   - b\n2. c", "# a\n#* b\n# c", 0},
		{"item with a fence and a second paragraph", "- a\n\n  more\n\n  ```go\n  x\n  ```\n- b",
			"* a\nmore\n{code:language=go}\nx\n{code}\n* b", 0},
		{"task list", "- [ ] open\n- [x] done", "* ☐ open\n* ☑ done", 0},
		{"pipe table", "| H | I |\n| :-- | --: |\n| **a** | `b \\| c` |\n|  | d |",
			"||H||I||\n|*a*|{{b \\| c}}|\n| |d|", 0},
		{"a fence written in a pipe cell is a code span", "| H |\n| --- |\n| ```go x``` |", "||H||\n|{{go x}}|", 0},
		{"html table with a fence and a list in a cell",
			"<table>\n<tr><th>\n\nH\n\n</th><th>\n\nI\n\n</th></tr>\n<tr><td>\n\n- a\n- b\n\n```go\nx\n```\n\n</td><td>\n\n```plantuml\nA -> B\n```\n\n</td></tr>\n</table>",
			"||H||I||\n|* a\n* b\n{code:language=go}\nx\n{code}|{plantuml}\nA -> B\n{plantuml}|", 0},
		{"html table colspan, rowspan and empty cell",
			"<table>\n<tr><th colspan=\"2\">\n\nH\n\n</th></tr>\n<tr><td rowspan=\"2\">\n\na\n\n</td><td>\n\n</td></tr>\n</table>",
			"||H|| ||\n|a| |", 0},
		{"html comment is dropped", "one\n\n<!-- note -->\n\ntwo", "one\n\ntwo", 0},
		{"other html block falls back", "<div>\nx\n</div>", "<div>\nx\n</div>", 1},
		{"always-special characters", "{a} [b] c | d !e!", `\{a\} \[b\] c \| d \!e\!`, 0},
		{"word-edge characters", "-a- +b+ ^c^ ??d?? \\_e\\_ \\~f\\~", `\-a\- \+b\+ \^c\^ \??d?\? \_e\_ \~f\~`, 0},
		{"mid-word characters", "a-b-c snake_case_name x^2 well-known", "a-b-c snake_case_name x^2 well-known", 0},
		{"line-start block markers", "h1. x\n\nbq. y\n\n\\* z\n\n\\# w", `\h1. x` + "\n\n" + `\bq. y` + "\n\n" + `\* z` + "\n\n" + `\# w`, 0},
		{"entity reference", "a &amp; b", "a & b", 0},
		{"code span", "`a {b} *c*`", `{{a \{b\} \*c\*}}`, 0},
		{"emphasis", "*a* and **b**", "_a_ and *b*", 0},
		{"strikethrough", "~~a~~", "-a-", 0},
		{"web link", `[a](https://x.example "title")`, "[a|https://x.example]", 0},
		{"mail link", "[a](mailto:a@x.example)", "[a|mailto:a@x.example]", 0},
		{"sieve link is text only", "[a](sieve://00000000-0000-7000-8000-000000000000)", "a", 0},
		{"reference link and its definition", "[a][r]\n\n[r]: https://x.example", "[a|https://x.example]", 0},
		{"autolink", "see https://x.example.", "see [https://x.example].", 0},
		{"email autolink", "<a@x.example>", "[mailto:a@x.example]", 0},
		{"web image", "![alt](https://x.example/i.png)", "[alt|https://x.example/i.png]", 0},
		{"asset image is its alt text", "![alt](assets/i.png)", "alt", 0},
		{"inline br is a line break", "a<br>b", `a\\b`, 0},
		{"other inline html is dropped", "a <span>b</span> c", "a b c", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, fallbacks := transpile(tc.md)
			if got != tc.want {
				t.Errorf("got\n%s\nwant\n%s", got, tc.want)
			}
			if fallbacks != tc.fallbacks {
				t.Errorf("fallbacks = %d, want %d", fallbacks, tc.fallbacks)
			}
		})
	}
}

// A fence is the same macro whether it is a block, a fence in prose, or a fence
// in a table cell.
func TestConfluenceGenerator_FenceIsOneMacroEverywhere(t *testing.T) {
	cases := []struct {
		name  string
		block SieveBlock
		fence string
	}{
		{"code", SieveBlock{Kind: "code", Attrs: map[string]interface{}{"language": "golang", "source": "x := 1\n"}}, "```golang\nx := 1\n```"},
		{"code without a language", SieveBlock{Kind: "code", Attrs: map[string]interface{}{"source": "x"}}, "```\nx\n```"},
		{"log", SieveBlock{Kind: "log", Attrs: map[string]interface{}{"source": "ERROR x"}}, "```\nERROR x\n```"},
		{"plantuml diagram", SieveBlock{Kind: "diagram", Attrs: map[string]interface{}{"diagramType": "plantuml", "source": "A -> B"}}, "```plantuml\nA -> B\n```"},
		{"mermaid diagram", SieveBlock{Kind: "diagram", Attrs: map[string]interface{}{"diagramType": "mermaid", "source": "graph LR"}}, "```mermaid\ngraph LR\n```"},
		{"engine-less diagram", SieveBlock{Kind: "diagram", Attrs: map[string]interface{}{"source": "graph LR"}}, "```mermaid\ngraph LR\n```"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			macro := NewConfluenceGenerator().RenderBlock(tc.block, "non-empty representation")
			if prose, _ := transpile(tc.fence); prose != macro {
				t.Errorf("block renders\n%s\nprose fence renders\n%s", macro, prose)
			}
			cell, _ := transpile("<table>\n<tr><td>\n\n" + tc.fence + "\n\n</td></tr>\n</table>")
			if want := "|" + macro + "|"; cell != want {
				t.Errorf("cell renders\n%s\nwant\n%s", cell, want)
			}
		})
	}
}

// A block whose markdown representation is empty is left out of the export.
func TestConfluenceGenerator_EmptyRepresentationRendersEmpty(t *testing.T) {
	b := SieveBlock{Kind: "code", Attrs: map[string]interface{}{"language": "go", "source": ""}}
	if got := NewConfluenceGenerator().RenderBlock(b, ""); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// Every goldmark node kind linked into this binary has a renderer, unless the
// transpiler's parser can never produce it: parser-internal kinds that never
// survive into a finished tree, kinds of GFM extensions it does not enable, and
// the region scanner's own node.
func TestConfluenceGenerator_EveryProducibleNodeKindHasARenderer(t *testing.T) {
	unproducible := map[string]bool{
		"Delimiter": true, "LinkLabelState": true,
		"FootnoteLink": true, "FootnoteBacklink": true, "Footnote": true, "FootnoteList": true,
		"DefinitionList": true, "DefinitionTerm": true, "DefinitionDescription": true,
		kindShapeNode.String(): true,
	}
	g := NewConfluenceGenerator()
	for k := ast.NodeKind(1); ; k++ {
		name, ok := nodeKindName(k)
		if !ok {
			break
		}
		if _, registered := g.renderers[k]; !registered && !unproducible[name] {
			t.Errorf("node kind %s has no renderer", name)
		}
	}
}

// nodeKindName returns k's name, or false past the last kind registered.
func nodeKindName(k ast.NodeKind) (name string, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return k.String(), true
}

// The two export generators are found by their format words; nothing else is.
func TestExportGenerators_Lookup(t *testing.T) {
	for _, format := range []string{ExportFormatMarkdown, ExportFormatConfluence} {
		if _, ok := (ExportGenerators{}).Lookup(format); !ok {
			t.Errorf("Lookup(%q) found nothing", format)
		}
	}
	for _, format := range []string{"", "html", "Markdown"} {
		if _, ok := (ExportGenerators{}).Lookup(format); ok {
			t.Errorf("Lookup(%q) found a generator", format)
		}
	}
}
