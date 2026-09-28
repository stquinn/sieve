package block

import (
	"encoding/xml"
	"io"
	"os"
	"strings"
	"testing"
)

// transpile runs prose markdown through a fresh generator.
func transpile(md string) string {
	return NewConfluenceGenerator().RenderBlock(SieveBlock{Kind: "prose"}, md)
}

// codeMacro is the storage-format code macro a test row expects: language is
// omitted when empty.
func codeMacro(language, body string) string {
	parameter := ""
	if language != "" {
		parameter = "  <ac:parameter ac:name=\"language\">" + language + "</ac:parameter>\n"
	}
	return "<ac:structured-macro ac:name=\"code\" ac:schema-version=\"1\">\n" + parameter +
		"  <ac:plain-text-body><![CDATA[" + body + "]]></ac:plain-text-body>\n" +
		"</ac:structured-macro>"
}

// plantumlMacro is the storage-format plantuml macro a test row expects.
func plantumlMacro(body string) string {
	return "<ac:structured-macro ac:name=\"plantuml\" ac:schema-version=\"1\">\n" +
		"  <ac:parameter ac:name=\"atlassian-macro-output-type\">INLINE</ac:parameter>\n" +
		"  <ac:plain-text-body><![CDATA[" + body + "]]></ac:plain-text-body>\n" +
		"</ac:structured-macro>"
}

// One row per overridden node kind, and one per construct the stock XHTML
// renderer is relied on for: markdown in, storage format out.
func TestConfluenceGenerator_Transpile(t *testing.T) {
	cases := []struct {
		name, md, want string
	}{
		// The stock XHTML renderer, which already writes storage format.
		{"document joins blocks", "one\n\ntwo", "<p>one</p>\n<p>two</p>"},
		{"soft break", "one\ntwo", "<p>one\ntwo</p>"},
		{"hard break", "one\\\ntwo", "<p>one<br />\ntwo</p>"},
		{"heading", "### Third", "<h3>Third</h3>"},
		{"setext heading", "Title\n=====", "<h1>Title</h1>"},
		{"thematic break", "---", "<hr />"},
		{"blockquote", "> one\n>\n> two", "<blockquote>\n<p>one</p>\n<p>two</p>\n</blockquote>"},
		{"nested bullets", "- a\n  - b\n- c",
			"<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ul>"},
		{"bullet under a number", "1. a\n   - b\n2. c",
			"<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ol>"},
		{"entity reference", "a &amp; b", "<p>a &amp; b</p>"},
		{"code span", "`a {b} *c*`", "<p><code>a {b} *c*</code></p>"},
		{"emphasis", "*a* and **b**", "<p><em>a</em> and <strong>b</strong></p>"},
		{"pipe table keeps its alignment", "| H | I |\n| :-- | --: |\n| **a** | `b \\| c` |",
			"<table>\n<thead>\n<tr>\n<th align=\"left\">H</th>\n<th align=\"right\">I</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n" +
				"<td align=\"left\"><strong>a</strong></td>\n<td align=\"right\"><code>b | c</code></td>\n</tr>\n</tbody>\n</table>"},
		{"html comment is dropped", "one\n\n<!-- a -- note -->\n\ntwo", "<p>one</p>\n<p>two</p>"},
		{"text after a comment survives it", "x\n<!-- c -->y", "<p>x</p>\ny"},
		{"an unclosed comment takes the rest of its block", "x\n\n<!-- c\nd", "<p>x</p>"},
		{"autolink", "see https://x.example.", `<p>see <a href="https://x.example">https://x.example</a>.</p>`},
		{"email autolink", "<a@x.example>", `<p><a href="mailto:a@x.example">a@x.example</a></p>`},
		{"sieve autolink is its text alone", "<sieve://00000000-0000-7000-8000-000000000000>",
			"<p>sieve://00000000-0000-7000-8000-000000000000</p>"},
		{"web autolink in angle brackets", "<https://x.example/a>",
			`<p><a href="https://x.example/a">https://x.example/a</a></p>`},

		// The overridden node kinds.
		{"fence with a listed language", "```golang\nx := 1\n```", codeMacro("go", "x := 1")},
		{"fence with an unlisted language", "```cobolish\nx\n```", codeMacro("", "x")},
		{"fence without a language", "```\nx\n```", codeMacro("", "x")},
		{"fence holding a CDATA terminator", "```\na ]]> b\n```", codeMacro("", "a ]]]]><![CDATA[> b")},
		{"fence opening on a blank line keeps it", "```\n\nx\n```", codeMacro("", "\nx")},
		{"plantuml fence", "```plantuml\n@startuml\nA -> B\n@enduml\n```",
			plantumlMacro("@startuml\nA -> B\n@enduml")},
		{"mermaid fence", "```mermaid\ngraph LR; A-->B\n```", codeMacro("", "graph LR; A-->B")},
		{"indented code", "    x := 1\n    y := 2", codeMacro("", "x := 1\ny := 2")},
		{"fence in a list item", "- a\n\n  ```go\n  x\n  ```\n- b",
			"<ul>\n<li>\n<p>a</p>\n" + codeMacro("go", "x") + "\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>"},
		{"task list", "- [ ] open\n- [x] done", "<ul>\n<li>☐ open</li>\n<li>☑ done</li>\n</ul>"},
		{"web link", `[a](https://x.example "title")`, `<p><a href="https://x.example">a</a></p>`},
		{"mail link", "[a](mailto:a@x.example)", `<p><a href="mailto:a@x.example">a</a></p>`},
		{"sieve link is its text alone", "[a](sieve://00000000-0000-7000-8000-000000000000)", "<p>a</p>"},
		{"reference link and its definition", "[a][r]\n\n[r]: https://x.example", `<p><a href="https://x.example">a</a></p>`},
		{"strikethrough", "~~a~~", `<p><span style="text-decoration: line-through;">a</span></p>`},
		{"web image", "![alt](https://x.example/i.png)", `<p><ac:image><ri:url ri:value="https://x.example/i.png"/></ac:image></p>`},
		{"asset image is its alt text", "![*alt*](assets/i.png)", "<p><em>alt</em></p>"},

		{"inline br is closed", "a<br>b", "<p>a<br />b</p>"},
		{"a br on its own line is closed", "a\n\n<br>\n\nb", "<p>a</p>\n<br />\n<p>b</p>"},
		{"an hr on its own line is closed", "<hr>", "<hr />"},
		{"an img on its own line is closed", `<img src="https://x.example/i.png">`,
			`<img src="https://x.example/i.png" />`},
		{"a void tag already closed is left alone", "<hr />", "<hr />"},
		{"other inline html is dropped", "a <span>b</span> c", "<p>a b c</p>"},
		{"characters XML forbids are dropped", "a \x1b[31mb\x00c", "<p>a [31mbc</p>"},
		{"a fence body's control characters are dropped", "```\nERROR \x1b[31mred\n```", codeMacro("", "ERROR [31mred")},

		// Raw HTML BLOCKS pass through, which is what makes the HTML-skeleton
		// table (#162) render its cell content as markdown with no code of our own.
		{"html table with a fence and a list in a cell",
			"<table>\n<tr><th>\n\nH\n\n</th></tr>\n<tr><td>\n\n- a\n\n```go\nx\n```\n\n</td></tr>\n</table>",
			"<table>\n<tr><th>\n<p>H</p>\n</th></tr>\n<tr><td>\n<ul>\n<li>a</li>\n</ul>\n" +
				codeMacro("go", "x") + "\n</td></tr>\n</table>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := transpile(tc.md)
			if got != tc.want {
				t.Errorf("got\n%s\nwant\n%s", got, tc.want)
			}
			if err := wellFormed(got); err != nil {
				t.Errorf("output is not well-formed XML: %v\n%s", err, got)
			}
		})
	}
}

// wellFormed reports whether body parses as XML once the macro namespaces it
// uses are declared. Confluence refuses a page body that does not: one unclosed
// tag, one `--` inside a comment or one control character loses the whole paste,
// not the construct that carried it.
func wellFormed(body string) error {
	rooted := `<page xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">` +
		body + `</page>`
	decoder := xml.NewDecoder(strings.NewReader(rooted))
	for {
		if _, err := decoder.Token(); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
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
			if prose := transpile(tc.fence); prose != macro {
				t.Errorf("block renders\n%s\nprose fence renders\n%s", macro, prose)
			}
			cell := transpile("<table>\n<tr><td>\n\n" + tc.fence + "\n\n</td></tr>\n</table>")
			if want := "<table>\n<tr><td>\n" + macro + "\n</td></tr>\n</table>"; cell != want {
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

// The exact text pasted at work — the whole exported UAT corpus, not one
// construct at a time — is well-formed XML.
func TestConfluenceGenerator_GoldenIsWellFormedXML(t *testing.T) {
	body, err := os.ReadFile("testdata/confluence-uat.storage")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if err := wellFormed(string(body)); err != nil {
		t.Fatalf("golden is not well-formed XML: %v", err)
	}
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
