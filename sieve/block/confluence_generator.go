package block

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"golang.org/x/net/html"
)

// ConfluenceGenerator renders a document export as Confluence wiki markup, the
// text Confluence's Insert → Markup dialog accepts as "Confluence wiki markup".
//
// code, log and diagram blocks become macros directly from their attributes.
// Every other block's markdown is transpiled: parsed by a goldmark instance that
// enables exactly GFM (tables, strikethrough, task lists, linkify), so the node
// kinds it can produce form a closed set, each with a renderer. A fence becomes
// the same macro wherever it appears — as a block, in prose, in a table cell.
//
// A node kind with no renderer, and an HTML block that is neither a comment nor
// part of a table, falls back to its escaped text and is counted (Fallbacks).
// Safe for concurrent use.
type ConfluenceGenerator struct {
	md        goldmark.Markdown
	renderers map[ast.NodeKind]confluenceNodeRenderer
	fallbacks atomic.Int64
}

// confluenceNodeRenderer renders one goldmark node, children included.
type confluenceNodeRenderer func(r *confluenceRender, n ast.Node) string

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

// confluenceLineMarker matches escaped text that would open a wiki block (a
// heading, a quote, a list item, a rule) if it began a line.
var confluenceLineMarker = regexp.MustCompile(`^(h[1-6]\.|bq\.|[*#-])`)

// confluenceLineBreak matches an inline HTML line break tag.
var confluenceLineBreak = regexp.MustCompile(`(?i)^<br\s*/?>$`)

// NewConfluenceGenerator returns a generator with its own GFM goldmark instance.
func NewConfluenceGenerator() *ConfluenceGenerator {
	g := &ConfluenceGenerator{
		md: goldmark.New(goldmark.WithExtensions(
			extension.Table, extension.Strikethrough, extension.TaskList, extension.Linkify,
		)),
	}
	g.renderers = map[ast.NodeKind]confluenceNodeRenderer{
		ast.KindDocument:                (*confluenceRender).document,
		ast.KindParagraph:               (*confluenceRender).paragraph,
		ast.KindTextBlock:               (*confluenceRender).paragraph,
		ast.KindHeading:                 (*confluenceRender).heading,
		ast.KindThematicBreak:           (*confluenceRender).thematicBreak,
		ast.KindFencedCodeBlock:         (*confluenceRender).fencedCodeBlock,
		ast.KindCodeBlock:               (*confluenceRender).codeBlock,
		ast.KindBlockquote:              (*confluenceRender).blockquote,
		ast.KindList:                    (*confluenceRender).list,
		ast.KindListItem:                (*confluenceRender).listItem,
		ast.KindHTMLBlock:               (*confluenceRender).htmlBlock,
		ast.KindLinkReferenceDefinition: (*confluenceRender).linkReferenceDefinition,
		ast.KindText:                    (*confluenceRender).textNode,
		ast.KindString:                  (*confluenceRender).stringNode,
		ast.KindCodeSpan:                (*confluenceRender).codeSpan,
		ast.KindEmphasis:                (*confluenceRender).emphasis,
		ast.KindLink:                    (*confluenceRender).link,
		ast.KindAutoLink:                (*confluenceRender).autoLink,
		ast.KindImage:                   (*confluenceRender).image,
		ast.KindRawHTML:                 (*confluenceRender).rawHTML,
		east.KindStrikethrough:          (*confluenceRender).strikethrough,
		east.KindTaskCheckBox:           (*confluenceRender).taskCheckBox,
		east.KindTable:                  (*confluenceRender).table,
		east.KindTableHeader:            (*confluenceRender).tableRow,
		east.KindTableRow:               (*confluenceRender).tableRow,
		east.KindTableCell:              (*confluenceRender).tableCell,
	}
	return g
}

// Fallbacks returns how many nodes this generator has rendered through the
// fallback since it was made.
func (g *ConfluenceGenerator) Fallbacks() int { return int(g.fallbacks.Load()) }

// RenderBlock renders one exported block as wiki markup: a code, log or diagram
// block as its macro, anything else by transpiling its markdown. A block whose
// markdown is empty renders empty.
func (g *ConfluenceGenerator) RenderBlock(b SieveBlock, markdown string) string {
	if strings.TrimSpace(markdown) == "" {
		return ""
	}
	source, _ := b.Attrs["source"].(string)
	switch b.Kind {
	case "code":
		language, _ := b.Attrs["language"].(string)
		return g.fence(language, source)
	case "log":
		return g.fence("", source)
	case "diagram":
		if engine, _ := b.Attrs["diagramType"].(string); strings.EqualFold(strings.TrimSpace(engine), "plantuml") {
			return g.fence("plantuml", source)
		}
		return g.fence("", source)
	}
	return g.transpile(markdown)
}

// fence is the one fence → macro mapping: a plantuml fence is the plantuml
// macro, a language Confluence lists is a code macro naming it, and any other
// fence is a code macro without a language. language is a fence info string;
// only its first word counts.
func (g *ConfluenceGenerator) fence(language, body string) string {
	body = strings.Trim(body, "\n")
	word := ""
	if fields := strings.Fields(language); len(fields) > 0 {
		word = strings.ToLower(fields[0])
	}
	if word == "plantuml" {
		return "{plantuml}\n" + body + "\n{plantuml}"
	}
	if name, ok := confluenceCodeLanguages[word]; ok {
		return "{code:language=" + name + "}\n" + body + "\n{code}"
	}
	return "{code}\n" + body + "\n{code}"
}

// transpile renders prose markdown as wiki markup.
func (g *ConfluenceGenerator) transpile(markdown string) string {
	src := []byte(markdown)
	r := &confluenceRender{g: g, src: src}
	return r.node(g.md.Parser().Parse(text.NewReader(src)))
}

// escape backslash-escapes text for wiki markup. `{ } [ ] | !` are always
// escaped. `* _ - + ^ ~ ?` are escaped only at a word edge: whitespace on one
// side and a non-space on the other. before and after are the characters
// adjacent to s, with ' ' standing for a line edge.
func (g *ConfluenceGenerator) escape(s string, before, after rune) string {
	runes := []rune(s)
	var b strings.Builder
	for i, c := range runes {
		switch c {
		case '{', '}', '[', ']', '|', '!':
			b.WriteByte('\\')
		case '*', '_', '-', '+', '^', '~', '?':
			left, right := before, after
			if i > 0 {
				left = runes[i-1]
			}
			if i < len(runes)-1 {
				right = runes[i+1]
			}
			if unicode.IsSpace(left) != unicode.IsSpace(right) {
				b.WriteByte('\\')
			}
		}
		b.WriteRune(c)
	}
	return b.String()
}

// escapeLineStart escapes the first character of escaped text that would
// otherwise open a wiki block at the start of a line.
func (g *ConfluenceGenerator) escapeLineStart(escaped string) string {
	if confluenceLineMarker.MatchString(escaped) {
		return `\` + escaped
	}
	return escaped
}

// confluenceRender is one transpilation: the source being rendered and the
// position the output is at.
type confluenceRender struct {
	g   *ConfluenceGenerator
	src []byte
	// markers is the list marker path of the item being rendered: `*`, `#*`, …
	markers string
	// tight joins sibling blocks with a single newline rather than a blank line,
	// as a list item or table cell must: a blank line would end it.
	tight bool
	// lineStart is true while the next inline output begins a line.
	lineStart bool
}

// node renders n through its kind's renderer, or through the fallback.
func (r *confluenceRender) node(n ast.Node) string {
	if n.Type() == ast.TypeInline && n.Kind() != ast.KindText && n.Kind() != ast.KindString {
		r.lineStart = false
	}
	render, ok := r.g.renderers[n.Kind()]
	if !ok {
		return r.fallback(n)
	}
	return render(r, n)
}

// fallback renders n as its escaped text content and counts the hit.
func (r *confluenceRender) fallback(n ast.Node) string {
	r.g.fallbacks.Add(1)
	return r.g.escape(r.textContent(n), ' ', ' ')
}

// textContent is the plain text n holds: a leaf block's lines, or its children's.
func (r *confluenceRender) textContent(n ast.Node) string {
	var b strings.Builder
	if n.Type() == ast.TypeBlock && !n.HasChildren() {
		b.WriteString(r.lines(n))
	}
	switch t := n.(type) {
	case *ast.Text:
		b.WriteString(r.textValue(t))
	case *ast.String:
		b.Write(t.Value)
	}
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		b.WriteString(r.textContent(c))
	}
	return b.String()
}

// lines is a block's source lines, verbatim.
func (r *confluenceRender) lines(n ast.Node) string {
	var b strings.Builder
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		line := lines.At(i)
		b.Write(line.Value(r.src))
	}
	return b.String()
}

// blocks renders a run of sibling blocks starting at first and joins them. An
// HTML block opening a table consumes the siblings up to its `</table>`.
func (r *confluenceRender) blocks(first ast.Node) string {
	var parts []string
	for c := first; c != nil; c = c.NextSibling() {
		var out string
		if r.opensHTMLTable(c) {
			out, c = r.htmlTable(c)
		} else {
			out = r.node(c)
		}
		if out != "" {
			parts = append(parts, out)
		}
	}
	sep := "\n\n"
	if r.tight {
		sep = "\n"
	}
	return strings.Join(parts, sep)
}

// inlines renders n's inline children.
func (r *confluenceRender) inlines(n ast.Node) string {
	var b strings.Builder
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		b.WriteString(r.node(c))
	}
	return b.String()
}

// withTight renders with sibling blocks joined tightly.
func (r *confluenceRender) withTight(render func() string) string {
	saved := r.tight
	r.tight = true
	defer func() { r.tight = saved }()
	return render()
}

func (r *confluenceRender) document(n ast.Node) string { return r.blocks(n.FirstChild()) }

func (r *confluenceRender) paragraph(n ast.Node) string {
	r.lineStart = true
	defer func() { r.lineStart = false }()
	return r.inlines(n)
}

func (r *confluenceRender) heading(n ast.Node) string {
	return fmt.Sprintf("h%d. %s", n.(*ast.Heading).Level, r.inlines(n))
}

func (r *confluenceRender) thematicBreak(ast.Node) string { return "----" }

func (r *confluenceRender) fencedCodeBlock(n ast.Node) string {
	return r.g.fence(string(n.(*ast.FencedCodeBlock).Language(r.src)), r.lines(n))
}

func (r *confluenceRender) codeBlock(n ast.Node) string { return r.g.fence("", r.lines(n)) }

func (r *confluenceRender) blockquote(n ast.Node) string {
	return "{quote}\n" + r.blocks(n.FirstChild()) + "\n{quote}"
}

func (r *confluenceRender) list(n ast.Node) string {
	marker := "*"
	if n.(*ast.List).IsOrdered() {
		marker = "#"
	}
	saved := r.markers
	r.markers += marker
	defer func() { r.markers = saved }()
	items := make([]string, 0, n.ChildCount())
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		items = append(items, r.node(c))
	}
	return strings.Join(items, "\n")
}

// listItem renders the item line — its marker path and its first paragraph —
// followed by the item's other blocks on the lines after it.
func (r *confluenceRender) listItem(n ast.Node) string {
	line := r.markers + " "
	rest := n.FirstChild()
	if rest != nil && (rest.Kind() == ast.KindParagraph || rest.Kind() == ast.KindTextBlock) {
		line += r.node(rest)
		rest = rest.NextSibling()
	}
	if rest == nil {
		return line
	}
	return line + "\n" + r.withTight(func() string { return r.blocks(rest) })
}

func (r *confluenceRender) htmlBlock(n ast.Node) string {
	if n.(*ast.HTMLBlock).HTMLBlockType == ast.HTMLBlockType2 {
		return ""
	}
	return r.fallback(n)
}

// htmlBlockSource is an HTML block's raw source, closure line included.
func (r *confluenceRender) htmlBlockSource(n *ast.HTMLBlock) string {
	raw := r.lines(n)
	if n.HasClosure() {
		raw += string(n.ClosureLine.Value(r.src))
	}
	return raw
}

func (r *confluenceRender) linkReferenceDefinition(ast.Node) string { return "" }

// textNode renders a text node escaped, then its line break.
func (r *confluenceRender) textNode(n ast.Node) string {
	t := n.(*ast.Text)
	switch {
	case t.HardLineBreak():
		return r.inlineText(r.textValue(t), n, ' ') + `\\`
	case t.SoftLineBreak():
		return r.inlineText(r.textValue(t), n, ' ') + " "
	}
	return r.inlineText(r.textValue(t), n, r.edgeRune(n.NextSibling(), true))
}

func (r *confluenceRender) stringNode(n ast.Node) string {
	return r.inlineText(string(n.(*ast.String).Value), n, r.edgeRune(n.NextSibling(), true))
}

// inlineText escapes the text of node n. Its neighbours decide the word edges:
// a sibling text's adjacent character, or a line edge beside anything else; after
// is the character that follows it. Text that begins a line has a block marker
// escaped too.
func (r *confluenceRender) inlineText(value string, n ast.Node, after rune) string {
	out := r.g.escape(value, r.edgeRune(n.PreviousSibling(), false), after)
	if r.lineStart && out != "" {
		out = r.g.escapeLineStart(out)
		r.lineStart = false
	}
	return out
}

// edgeRune is the character of sibling that touches a text node: its first
// character when it follows the node, its last when it precedes it. A sibling
// that is not text, or ends in a line break, touches as a line edge.
func (r *confluenceRender) edgeRune(sibling ast.Node, following bool) rune {
	var value string
	switch t := sibling.(type) {
	case *ast.Text:
		if !following && (t.SoftLineBreak() || t.HardLineBreak()) {
			return ' '
		}
		value = r.textValue(t)
	case *ast.String:
		value = string(t.Value)
	}
	if value == "" {
		return ' '
	}
	if following {
		c, _ := utf8.DecodeRuneInString(value)
		return c
	}
	c, _ := utf8.DecodeLastRuneInString(value)
	return c
}

// textValue is a text node's characters, with markdown escapes and character
// references resolved.
func (r *confluenceRender) textValue(t *ast.Text) string {
	value := t.Segment.Value(r.src)
	if t.IsRaw() {
		return string(value)
	}
	return string(util.ResolveEntityNames(util.ResolveNumericReferences(util.UnescapePunctuations(value))))
}

func (r *confluenceRender) codeSpan(n ast.Node) string {
	var b strings.Builder
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		if t, ok := c.(*ast.Text); ok {
			b.Write(bytes.ReplaceAll(t.Segment.Value(r.src), []byte("\n"), []byte(" ")))
		}
	}
	return "{{" + r.g.escape(b.String(), ' ', ' ') + "}}"
}

func (r *confluenceRender) emphasis(n ast.Node) string {
	marker := "_"
	if n.(*ast.Emphasis).Level == 2 {
		marker = "*"
	}
	return marker + r.inlines(n) + marker
}

func (r *confluenceRender) strikethrough(n ast.Node) string { return "-" + r.inlines(n) + "-" }

// link renders a link Confluence can follow as `[text|url]`, and any other link
// as its text alone.
func (r *confluenceRender) link(n ast.Node) string {
	label := r.inlines(n)
	dest := string(n.(*ast.Link).Destination)
	if !r.isWebURL(dest, true) {
		return label
	}
	return "[" + label + "|" + dest + "]"
}

func (r *confluenceRender) autoLink(n ast.Node) string {
	a := n.(*ast.AutoLink)
	url := string(a.URL(r.src))
	if a.AutoLinkType == ast.AutoLinkEmail && !strings.HasPrefix(strings.ToLower(url), "mailto:") {
		url = "mailto:" + url
	}
	return "[" + url + "]"
}

// image renders a web image as a link labelled with its alt text, and any other
// image as the alt text alone.
func (r *confluenceRender) image(n ast.Node) string {
	alt := r.g.escape(r.textContent(n), ' ', ' ')
	dest := string(n.(*ast.Image).Destination)
	if !r.isWebURL(dest, false) {
		return alt
	}
	return "[" + alt + "|" + dest + "]"
}

// isWebURL reports whether dest resolves outside Sieve: an http(s) URL, or a
// mailto: one when mail is allowed.
func (r *confluenceRender) isWebURL(dest string, mail bool) bool {
	lower := strings.ToLower(dest)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") ||
		(mail && strings.HasPrefix(lower, "mailto:"))
}

func (r *confluenceRender) rawHTML(n ast.Node) string {
	segments := n.(*ast.RawHTML).Segments
	var b strings.Builder
	for i := 0; i < segments.Len(); i++ {
		segment := segments.At(i)
		b.Write(segment.Value(r.src))
	}
	if confluenceLineBreak.MatchString(strings.TrimSpace(b.String())) {
		return `\\`
	}
	return ""
}

func (r *confluenceRender) taskCheckBox(n ast.Node) string {
	if n.(*east.TaskCheckBox).IsChecked {
		return "☑ "
	}
	return "☐ "
}

func (r *confluenceRender) table(n ast.Node) string {
	rows := make([]string, 0, n.ChildCount())
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		rows = append(rows, r.node(c))
	}
	return strings.Join(rows, "\n")
}

// tableRow renders a pipe-table row: `||h||h||` for the header, `|c|c|` below.
func (r *confluenceRender) tableRow(n ast.Node) string {
	delim := "|"
	if n.Kind() == east.KindTableHeader {
		delim = "||"
	}
	var b strings.Builder
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		b.WriteString(delim + r.node(c))
	}
	return b.String() + delim
}

func (r *confluenceRender) tableCell(n ast.Node) string {
	r.lineStart = true
	defer func() { r.lineStart = false }()
	return confluenceCell{content: []string{r.inlines(n)}}.body()
}

// opensHTMLTable reports whether n is an HTML block that opens a table.
func (r *confluenceRender) opensHTMLTable(n ast.Node) bool {
	h, ok := n.(*ast.HTMLBlock)
	return ok && strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.htmlBlockSource(h))), "<table")
}

// htmlTable renders an HTML table whose tags are spread over a run of sibling
// HTML blocks, with the markdown blocks between them as its cell content. It
// consumes siblings from start up to the HTML block that closes the table, and
// returns the wiki table and the last node consumed.
func (r *confluenceRender) htmlTable(start ast.Node) (string, ast.Node) {
	var t confluenceHTMLTable
	last := start
	for c := start; c != nil; c = c.NextSibling() {
		last = c
		if h, ok := c.(*ast.HTMLBlock); ok {
			if t.readTags(r.htmlBlockSource(h), r.g) {
				break
			}
			continue
		}
		t.addContent(r.withTight(func() string { return r.node(c) }))
	}
	return t.wiki(), last
}

// confluenceHTMLTable accumulates an HTML table's rows and cells.
type confluenceHTMLTable struct {
	rows [][]*confluenceCell
	open *confluenceCell
	last *confluenceCell
}

// confluenceCell is one table cell: its rendered blocks and how it spans.
type confluenceCell struct {
	header  bool
	colspan int
	content []string
}

// readTags advances the table through one HTML fragment's tags. Text between
// tags joins the open cell. It reports whether the fragment closed the table.
func (t *confluenceHTMLTable) readTags(fragment string, g *ConfluenceGenerator) bool {
	z := html.NewTokenizer(strings.NewReader(fragment))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return false
		case html.StartTagToken:
			tok := z.Token()
			switch tok.Data {
			case "tr":
				t.rows = append(t.rows, nil)
			case "th", "td":
				t.startCell(tok)
			}
		case html.EndTagToken:
			switch z.Token().Data {
			case "th", "td":
				t.open = nil
			case "table":
				return true
			}
		case html.TextToken:
			if s := strings.TrimSpace(string(z.Text())); s != "" {
				t.addContent(g.escape(s, ' ', ' '))
			}
		}
	}
}

// startCell opens a cell in the current row, starting a row if there is none.
func (t *confluenceHTMLTable) startCell(tok html.Token) {
	if len(t.rows) == 0 {
		t.rows = append(t.rows, nil)
	}
	cell := &confluenceCell{header: tok.Data == "th", colspan: 1}
	for _, a := range tok.Attr {
		if a.Key == "colspan" {
			if n, err := strconv.Atoi(strings.TrimSpace(a.Val)); err == nil && n > 1 {
				cell.colspan = n
			}
		}
	}
	row := len(t.rows) - 1
	t.rows[row] = append(t.rows[row], cell)
	t.open, t.last = cell, cell
}

// addContent appends rendered content to the open cell, or to the last cell
// when content falls between cells. Content before any cell is dropped.
func (t *confluenceHTMLTable) addContent(s string) {
	target := t.open
	if target == nil {
		target = t.last
	}
	if target != nil && s != "" {
		target.content = append(target.content, s)
	}
}

// wiki renders the table: each cell opened by `||` (header) or `|`, a row closed
// by its last cell's delimiter, and a colspan as that many cells.
func (t *confluenceHTMLTable) wiki() string {
	rows := make([]string, 0, len(t.rows))
	for _, cells := range t.rows {
		if len(cells) == 0 {
			continue
		}
		var b strings.Builder
		delim := "|"
		for _, c := range cells {
			delim = c.delimiter()
			b.WriteString(delim + c.body())
			for i := 1; i < c.colspan; i++ {
				b.WriteString(delim + " ")
			}
		}
		rows = append(rows, b.String()+delim)
	}
	return strings.Join(rows, "\n")
}

func (c confluenceCell) delimiter() string {
	if c.header {
		return "||"
	}
	return "|"
}

// body is the cell's content, one block per line; an empty cell is a space, so
// that its delimiters never read as a header's `||`.
func (c confluenceCell) body() string {
	s := strings.Join(c.content, "\n")
	if strings.TrimSpace(s) == "" {
		return " "
	}
	return s
}
