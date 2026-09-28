package block

import (
	"bytes"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/renderer"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

// ConfluenceGenerator renders a document export as Confluence storage format,
// the XHTML a page is stored as, pasted into the editor's source view.
//
// code, log and diagram blocks become macros directly from their attributes.
// Every other block's markdown is rendered by a goldmark instance of its own
// that enables exactly GFM (tables, strikethrough, task lists, linkify) and
// writes XHTML with raw HTML passed through: headings, paragraphs, lists,
// quotes, tables and inline formatting are already storage format, so only the
// nodes Confluence spells differently are overridden (storageNodes). A fence
// becomes the same macro wherever it appears — as a block, in prose, in a table
// cell.
//
// Confluence refuses a page body that is not well-formed XML, so the output is
// stripped of the characters XML forbids and of comments, no inline tag is
// passed through unclosed, and a tag for an element that cannot hold content is
// written self-closed. A raw HTML BLOCK is otherwise passed through as itself,
// because that is what renders an HTML-skeleton table's cells: one whose own
// tags do not balance makes the whole body unparseable. Safe for concurrent use.
type ConfluenceGenerator struct {
	md goldmark.Markdown
}

// confluenceRendererPriority registers the storage-format overrides above the
// stock renderers. goldmark registers node renderers from the highest priority
// number down, so the LOWEST number registers last and wins: this must stay
// below the stock XHTML renderer's 1000 and the GFM extensions' 500.
const confluenceRendererPriority = 100

// confluenceCodeLanguages maps a fence info word, lowercased, to the name
// Confluence's code macro takes as its language parameter. A word not in the map
// is a language Confluence does not list: its macro carries no language.
var confluenceCodeLanguages = map[string]string{
	"abap": "abap", "actionscript": "actionscript", "as3": "actionscript", "ada": "ada",
	"applescript": "applescript", "arduino": "arduino", "ino": "arduino", "autoit": "autoit",
	"c": "c", "h": "c", "c++": "cpp", "cpp": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp",
	"clojure": "clojure", "clj": "clojure", "coffeescript": "coffeescript", "coffee": "coffeescript",
	"coldfusion": "coldfusion", "cfm": "coldfusion", "csharp": "csharp", "c#": "csharp", "cs": "csharp",
	"css": "css", "cuda": "cuda", "cu": "cuda",
	"d": "d", "dart": "dart", "diff": "diff", "patch": "diff", "dockerfile": "dockerfile", "docker": "dockerfile",
	"elixir": "elixir", "ex": "elixir", "exs": "elixir", "erlang": "erlang", "erl": "erlang",
	"fortran": "fortran", "f90": "fortran", "foxpro": "foxpro",
	"go": "go", "golang": "go", "graphql": "graphql", "gql": "graphql", "groovy": "groovy", "gradle": "groovy",
	"haskell": "haskell", "hs": "haskell", "haxe": "haxe", "hx": "haxe", "hcl": "hcl", "terraform": "hcl", "tf": "hcl",
	"html": "html", "htm": "html", "xhtml": "html",
	"java": "java", "javafx": "javafx", "javascript": "javascript", "js": "javascript", "mjs": "javascript",
	"cjs": "javascript", "node": "javascript", "json": "json", "jsx": "jsx", "julia": "julia", "jl": "julia",
	"kotlin": "kotlin", "kt": "kotlin", "kts": "kotlin",
	"livescript": "livescript", "ls": "livescript", "lua": "lua",
	"mathematica": "mathematica", "wolfram": "mathematica", "matlab": "matlab",
	"nginx":       "nginx",
	"objective-c": "objectivec", "objectivec": "objectivec", "objc": "objectivec",
	"objective-j": "objectivej", "objectivej": "objectivej", "objj": "objectivej",
	"ocaml": "ocaml", "ml": "ocaml", "octave": "octave",
	"pascal": "pascal", "pas": "pascal", "delphi": "pascal", "perl": "perl", "pl": "perl", "php": "php",
	"plaintext": "plaintext", "text": "plaintext", "txt": "plaintext", "plain": "plaintext",
	"powershell": "powershell", "ps1": "powershell", "pwsh": "powershell", "prolog": "prolog",
	"protobuf": "protobuf", "proto": "protobuf", "puppet": "puppet", "pp": "puppet",
	"python": "python", "py": "python", "python3": "python",
	"qml": "qml",
	"r":   "r", "racket": "racket", "rkt": "racket", "restructuredtext": "restructuredtext", "rst": "restructuredtext",
	"ruby": "ruby", "rb": "ruby", "rust": "rust", "rs": "rust",
	"sass": "sass", "scss": "sass", "scala": "scala", "scheme": "scheme", "scm": "scheme",
	"shell": "shell", "sh": "shell", "bash": "shell", "zsh": "shell", "console": "shell", "shellsession": "shell",
	"smalltalk": "smalltalk", "st": "smalltalk", "splunkspl": "splunkspl", "spl": "splunkspl",
	"sql": "sql", "standardml": "standardml", "sml": "standardml", "swift": "swift",
	"tcl": "tcl", "tex": "tex", "latex": "tex", "tsx": "tsx", "typescript": "typescript", "ts": "typescript",
	"vala": "vala", "vbnet": "vbnet", "vb.net": "vbnet", "verilog": "verilog", "v": "verilog",
	"vhdl": "vhdl", "visualbasic": "visualbasic", "vb": "visualbasic", "vba": "visualbasic",
	"xml": "xml", "svg": "xml", "xsl": "xml", "xquery": "xquery", "xq": "xquery",
	"yaml": "yaml", "yml": "yaml",
}

// confluenceLineBreak matches an inline HTML line break tag.
var confluenceLineBreak = regexp.MustCompile(`(?i)^<br\s*/?>$`)

// confluenceVoidTag matches an HTML tag for an element that can never hold
// content, in whatever form it was written. XML has no such elements, so one
// left open makes the page body unparseable.
var confluenceVoidTag = regexp.MustCompile(`(?is)<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)([\s/][^>]*)?>`)

// confluenceComment matches a complete HTML comment, and confluenceCommentOpen
// the start of one that is never closed.
var (
	confluenceComment     = regexp.MustCompile(`(?s)<!--.*?-->`)
	confluenceCommentOpen = regexp.MustCompile(`(?s)<!--.*`)
)

// NewConfluenceGenerator returns a generator with its own GFM goldmark instance.
func NewConfluenceGenerator() *ConfluenceGenerator {
	g := &ConfluenceGenerator{}
	g.md = goldmark.New(
		goldmark.WithExtensions(
			extension.Table, extension.Strikethrough, extension.TaskList, extension.Linkify,
		),
		goldmark.WithRendererOptions(
			gmhtml.WithXHTML(),
			gmhtml.WithUnsafe(),
			renderer.WithNodeRenderers(util.Prioritized(&storageNodes{g: g}, confluenceRendererPriority)),
		),
	)
	return g
}

// RenderBlock renders one exported block as storage format: a code, log or
// diagram block as its macro, anything else by rendering its markdown. A block
// whose markdown is empty renders empty.
func (g *ConfluenceGenerator) RenderBlock(b SieveBlock, markdown string) string {
	if strings.TrimSpace(markdown) == "" {
		return ""
	}
	return g.xmlSafe(g.renderKind(b, markdown))
}

// renderKind is RenderBlock's kind switch, before the body is made XML-safe.
func (g *ConfluenceGenerator) renderKind(b SieveBlock, markdown string) string {
	source, _ := b.Attrs["source"].(string)
	switch b.Kind {
	case "code":
		language, _ := b.Attrs["language"].(string)
		return g.macro(language, source)
	case "log":
		return g.macro("", source)
	case "diagram":
		if engine, _ := b.Attrs["diagramType"].(string); strings.EqualFold(strings.TrimSpace(engine), "plantuml") {
			return g.macro("plantuml", source)
		}
		return g.macro("", source)
	}
	return g.transpile(markdown)
}

// macro is the one fence → macro rule: a plantuml fence is the plantuml macro, a
// language Confluence lists is a code macro naming it, and any other fence is a
// code macro with no language. language is a fence info string; only its first
// word counts.
func (g *ConfluenceGenerator) macro(language, body string) string {
	word := ""
	if fields := strings.Fields(language); len(fields) > 0 {
		word = strings.ToLower(fields[0])
	}
	if word == "plantuml" {
		return g.structuredMacro("plantuml", "atlassian-macro-output-type", "INLINE", body)
	}
	return g.structuredMacro("code", "language", confluenceCodeLanguages[word], body)
}

// structuredMacro is one macro element: its name, a single parameter — omitted
// when value is empty — and body as a CDATA section. ac:macro-id is omitted
// because Confluence mints one when the page is saved.
func (g *ConfluenceGenerator) structuredMacro(name, parameter, value, body string) string {
	var b strings.Builder
	b.WriteString(`<ac:structured-macro ac:name="` + name + `" ac:schema-version="1">` + "\n")
	if value != "" {
		b.WriteString(`  <ac:parameter ac:name="` + parameter + `">` + string(util.EscapeHTML([]byte(value))) + `</ac:parameter>` + "\n")
	}
	b.WriteString(`  <ac:plain-text-body><![CDATA[` + g.cdata(body) + `]]></ac:plain-text-body>` + "\n")
	b.WriteString(`</ac:structured-macro>`)
	return b.String()
}

// cdata is a macro body with every `]]>` split across two CDATA sections, so
// that the section holding it cannot be closed early. The newline a fence ends
// on is dropped; a blank line the body opens on is the author's and is kept.
func (g *ConfluenceGenerator) cdata(body string) string {
	return strings.ReplaceAll(strings.TrimRight(body, "\n"), "]]>", "]]]]><![CDATA[>")
}

// xmlSafe drops the characters XML 1.0 forbids, which a CDATA section does not
// exempt: a log block pasted from a terminal carries ANSI escapes, and
// Confluence refuses the whole page body over one of them rather than the block
// that held it.
func (g *ConfluenceGenerator) xmlSafe(body string) string {
	return strings.Map(func(c rune) rune {
		switch {
		case c == '\t' || c == '\n' || c == '\r':
			return c
		case c < 0x20, c == 0xfffe, c == 0xffff, c == utf8.RuneError:
			return -1
		}
		return c
	}, body)
}

// transpile renders prose markdown as storage-format XHTML.
func (g *ConfluenceGenerator) transpile(markdown string) string {
	var out bytes.Buffer
	// Convert writes to a bytes.Buffer, whose writes cannot fail.
	_ = g.md.Convert([]byte(markdown), &out)
	return strings.TrimRight(out.String(), "\n")
}

// followable reports whether dest resolves for a Confluence reader: an http(s)
// URL, or a mailto: one where mail counts. A sieve:// address and an assets/…
// path resolve only inside the running Sieve.
func (g *ConfluenceGenerator) followable(dest string, mail bool) bool {
	lower := strings.ToLower(dest)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") ||
		(mail && strings.HasPrefix(lower, "mailto:"))
}

// storageNodes renders the goldmark nodes Confluence storage format spells
// differently from HTML. Every other node comes from the stock XHTML renderer,
// which already writes storage format.
type storageNodes struct {
	g *ConfluenceGenerator
}

// RegisterFuncs registers a renderer for each overridden node kind.
func (s *storageNodes) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindFencedCodeBlock, s.fencedCodeBlock)
	reg.Register(ast.KindCodeBlock, s.codeBlock)
	reg.Register(ast.KindLink, s.link)
	reg.Register(ast.KindAutoLink, s.autoLink)
	reg.Register(ast.KindImage, s.image)
	reg.Register(ast.KindHTMLBlock, s.htmlBlock)
	reg.Register(ast.KindRawHTML, s.rawHTML)
	reg.Register(east.KindStrikethrough, s.strikethrough)
	reg.Register(east.KindTaskCheckBox, s.taskCheckBox)
}

// htmlBlock passes a raw HTML block through — that is what renders an
// HTML-skeleton table's cells as markdown — with its comments removed and its
// void tags closed, either of which Confluence would refuse the whole body over.
// A comment block is stripped of the comment alone, so text written after one on
// the same line survives it.
func (s *storageNodes) htmlBlock(w util.BufWriter, source []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	block := n.(*ast.HTMLBlock)
	if block.HTMLBlockType == ast.HTMLBlockType2 {
		if entering {
			_, _ = w.WriteString(s.closeVoidTags(s.uncomment(s.lines(source, n) + s.closure(source, block))))
		}
		return ast.WalkContinue, nil
	}
	if entering {
		_, _ = w.WriteString(s.closeVoidTags(s.lines(source, n)))
		return ast.WalkContinue, nil
	}
	_, _ = w.WriteString(s.closeVoidTags(s.closure(source, block)))
	return ast.WalkContinue, nil
}

// closure is a raw HTML block's closing line, empty when it has none.
func (s *storageNodes) closure(source []byte, block *ast.HTMLBlock) string {
	if !block.HasClosure() {
		return ""
	}
	return string(block.ClosureLine.Value(source))
}

// uncomment removes every comment from a raw HTML block — an unclosed one takes
// the rest of the block with it — and reports the remainder, empty when only
// whitespace is left.
func (s *storageNodes) uncomment(html string) string {
	rest := confluenceCommentOpen.ReplaceAllString(confluenceComment.ReplaceAllString(html, ""), "")
	if strings.TrimSpace(rest) == "" {
		return ""
	}
	return rest
}

// closeVoidTags writes every void element in a raw HTML block self-closed. One
// standing alone on a line is a block of its own, passed through as it was
// written: `<br>` unclosed loses the whole page body, not the line that held it.
func (s *storageNodes) closeVoidTags(html string) string {
	return confluenceVoidTag.ReplaceAllStringFunc(html, func(tag string) string {
		parts := confluenceVoidTag.FindStringSubmatch(tag)
		return "<" + parts[1] + strings.TrimRight(parts[2], " \t\r\n/") + " />"
	})
}

// rawHTML keeps a line break, closed as XHTML, and drops any other inline tag:
// one unclosed <br> or <img> in prose is a page body Confluence refuses whole.
func (s *storageNodes) rawHTML(w util.BufWriter, source []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	if confluenceLineBreak.MatchString(strings.TrimSpace(s.segments(source, n.(*ast.RawHTML)))) {
		_, _ = w.WriteString("<br />")
	}
	return ast.WalkSkipChildren, nil
}

// segments is an inline raw HTML node's source text, verbatim.
func (s *storageNodes) segments(source []byte, n *ast.RawHTML) string {
	var b strings.Builder
	for i := 0; i < n.Segments.Len(); i++ {
		segment := n.Segments.At(i)
		b.Write(segment.Value(source))
	}
	return b.String()
}

// fencedCodeBlock writes the fence's macro; the stock renderer's <pre><code> is
// not one.
func (s *storageNodes) fencedCodeBlock(w util.BufWriter, source []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	fence := n.(*ast.FencedCodeBlock)
	return s.writeMacro(w, string(fence.Language(source)), s.lines(source, n))
}

// codeBlock writes an indented code block as a macro with no language.
func (s *storageNodes) codeBlock(w util.BufWriter, source []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	return s.writeMacro(w, "", s.lines(source, n))
}

// writeMacro writes a fence's macro as a block element and skips the fence's own
// lines, which the macro already holds.
func (s *storageNodes) writeMacro(w util.BufWriter, language, body string) (ast.WalkStatus, error) {
	_, _ = w.WriteString(s.g.macro(language, body) + "\n")
	return ast.WalkSkipChildren, nil
}

// lines is a block node's source lines, verbatim.
func (s *storageNodes) lines(source []byte, n ast.Node) string {
	var b strings.Builder
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		line := lines.At(i)
		b.Write(line.Value(source))
	}
	return b.String()
}

// link writes an anchor for a destination a Confluence reader can follow, and
// renders any other link as its text alone. The title is dropped.
func (s *storageNodes) link(w util.BufWriter, _ []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	dest := n.(*ast.Link).Destination
	if !s.g.followable(string(dest), true) {
		return ast.WalkContinue, nil
	}
	if entering {
		_, _ = w.WriteString(`<a href="`)
		_, _ = w.Write(util.EscapeHTML(util.URLEscape(dest, true)))
		_, _ = w.WriteString(`">`)
		return ast.WalkContinue, nil
	}
	_, _ = w.WriteString(`</a>`)
	return ast.WalkContinue, nil
}

// autoLink writes an anchor for an address in angle brackets, or found by
// linkify, that a Confluence reader can follow, and renders any other — a
// <sieve://…> address — as its text alone.
func (s *storageNodes) autoLink(w util.BufWriter, source []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	link := n.(*ast.AutoLink)
	href := link.URL(source)
	if link.AutoLinkType == ast.AutoLinkEmail && !bytes.HasPrefix(bytes.ToLower(href), []byte("mailto:")) {
		href = append([]byte("mailto:"), href...)
	}
	if !s.g.followable(string(href), true) {
		_, _ = w.Write(util.EscapeHTML(link.Label(source)))
		return ast.WalkContinue, nil
	}
	_, _ = w.WriteString(`<a href="`)
	_, _ = w.Write(util.EscapeHTML(util.URLEscape(href, false)))
	_, _ = w.WriteString(`">`)
	_, _ = w.Write(util.EscapeHTML(link.Label(source)))
	_, _ = w.WriteString(`</a>`)
	return ast.WalkContinue, nil
}

// image writes a web image as an image attached by URL — <img> is not storage
// format — and renders any other image as its alt text alone.
func (s *storageNodes) image(w util.BufWriter, _ []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	dest := n.(*ast.Image).Destination
	if !s.g.followable(string(dest), false) {
		// The alt text's own inline nodes render in the image's place.
		return ast.WalkContinue, nil
	}
	if !entering {
		return ast.WalkContinue, nil
	}
	_, _ = w.WriteString(`<ac:image><ri:url ri:value="`)
	_, _ = w.Write(util.EscapeHTML(util.URLEscape(dest, true)))
	_, _ = w.WriteString(`"/></ac:image>`)
	return ast.WalkSkipChildren, nil
}

// strikethrough writes the span Confluence's storage subset carries; <del> is
// not in it.
func (s *storageNodes) strikethrough(w util.BufWriter, _ []byte, _ ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		_, _ = w.WriteString(`<span style="text-decoration: line-through;">`)
	} else {
		_, _ = w.WriteString(`</span>`)
	}
	return ast.WalkContinue, nil
}

// taskCheckBox writes the task's state as a glyph: the stock <input> is stripped
// by the Confluence editor, and a native ac:task-list needs the page-scoped ids
// Confluence assigns itself.
func (s *storageNodes) taskCheckBox(w util.BufWriter, _ []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	if n.(*east.TaskCheckBox).IsChecked {
		_, _ = w.WriteString("☑ ")
	} else {
		_, _ = w.WriteString("☐ ")
	}
	return ast.WalkContinue, nil
}
