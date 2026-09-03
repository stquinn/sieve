package processors

import (
	"bytes"
	"fmt"
	"slices"

	"sieve/sieve/block"
	"sieve/sieve/domain"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// ProseReading is prose's plain-text projection of one stored payload, and the
// map from that projection back to the bytes it came from.
//
// PROSE READS ITS MARKDOWN THROUGH THE PARSE, NOT AS BYTES. The reading is
// built per block-level node — paragraph, heading, list-item text — as the
// concatenation of that node's inline leaves. Text and code-span content read
// as themselves; a link contributes its TEXT and never its destination; an
// autolink contributes the ADDRESS its brackets hold; an image contributes its
// alt text; emphasis, strong and raw html contribute nothing but what they
// wrap, so their markers are absent from the reading by construction. A
// softbreak reads as one space, a hardbreak as a newline, and node readings join
// with a newline. A node bearing no inlines at all — a fence, an html block, a
// rule — contributes nothing.
//
// WHAT IS READ IS WHAT THE SURFACE DRAWS. An anchor is numbered in this reading
// and resolved again in the text the editor has on screen, so the two must hold
// the same characters or a mark is drawn over one run and spent on another. The
// surface parses the same markdown with html on: it draws an autolink's address
// and not the angle brackets around it, and it interprets an inline html tag
// rather than drawing it. That is the whole reason those two nodes are treated
// differently here.
//
// The reading is what every anchor into a prose block is meaningful against.
// The map back to the stored bytes is derived here, at the write, from content
// the locator's hash has already vouched for: identical bytes parse to an
// identical reading, so the span a reader named is the span this resolves.
// Nothing about the map ever leaves this type.
//
// A WRITE ONLY EVER TOUCHES BYTES THAT ARE IN THE READING. A resolved span
// covers a sequence of runs, and an edit cuts the covered part of each one and
// puts its replacement at the first cut. Marker bytes lie BETWEEN runs, so they
// are never inside a cut and an orphaned marker cannot be produced — not by
// rule, but by construction. A replacement therefore inherits whatever
// formatting its match began in, which is what a word processor does.
type ProseReading struct {
	source    []byte
	buf       []byte
	text      string
	runs      []readingRun
	nodes     []nodeBounds
	wrappers  []inlineWrapper
	softbreak int // index of the substitution run awaiting its end, or -1
	// cursor is how far into the source the current node has been consumed. An
	// inline node that hides its own bounds is found by searching forward from
	// here, so every stretch the reading did not take — a skipped tag, a
	// destination behind proved markers — advances it too.
	cursor int
}

// readingRun is a stretch of the reading that names stored bytes:
// text[at:at+length] was read out of source[raw:rawStop], and node is the
// block-level node it belongs to. Characters of the reading that lie between
// runs name no source at all and no write can reach them.
//
// ALMOST EVERY RUN IS THE SOURCE BYTE FOR BYTE, and mapsByteForByte says which.
// The exception is the SOFTBREAK SUBSTITUTION: one space of reading standing for
// the whole line ending it replaced. Such a run maps as a unit — a span that
// touches it takes all of its bytes — because there is no character-wise
// correspondence to divide.
type readingRun struct {
	at      int
	length  int
	raw     int
	rawStop int
	node    int
}

// nodeBounds is one block-level node's source. It is the widest a splice
// derived from that node may ever grow: a range is only ever placed within the
// node it was read from, because the bytes between two nodes are structure the
// reading never showed.
type nodeBounds struct {
	rawStart int
	rawStop  int
}

// inlineWrapper is one inline node whose source surrounds its content with
// markers the reading does not show: content bounds the bytes that DID reach
// the reading, full bounds those plus the markers.
//
// A wrapper is recorded ONLY when its marker bytes have been READ AND PROVED —
// source[fullStart:contentStart] and source[contentStop:fullStop] are exactly
// the characters that kind of marker is made of. Nothing here is derived by
// arithmetic from a node's type, because a node whose first or last child
// contributes less than its own source — raw html, an autolink inside its own
// brackets — puts other bytes where its markers would be, and deleting those
// corrupts the document.
//
// Its one use is the empty-pair trim: a pair whose content an edit consumes
// entirely has its markers removed too, so no empty `**` is left standing. A
// wrapper that could not prove its bytes is absent, and the worst that costs is
// a cosmetic empty pair nobody deleted.
type inlineWrapper struct {
	contentStart int
	contentStop  int
	fullStart    int
	fullStop     int
}

// rawCut is one stretch of stored bytes an edit removes. An edit resolves to a
// SEQUENCE of them — the covered portion of every run its match crosses — never
// to one span, because the bytes BETWEEN two runs are markup the reader never
// saw and the writer never named.
type rawCut struct {
	start int
	stop  int
}

// proseReadingParser parses exactly what prose's reading is derived from:
// stock markdown, with none of the shape parsers the codec's scanner adds. A
// prose payload's own delimiters were consumed by the codec long before this.
// goldmark's own state is fixed after the first parse, so one parser answers
// every reader.
var proseReadingParser = goldmark.New()

// NewProseReading projects content and builds the map back to it. Content that
// parses to nothing — empty, whitespace, a bare fence — yields an empty reading
// and no runs, which every method below answers for without special-casing.
func NewProseReading(content string) *ProseReading {
	r := &ProseReading{source: []byte(content), softbreak: -1}
	root := proseReadingParser.Parser().Parse(text.NewReader(r.source))
	r.collect(root)
	r.text = string(r.buf)
	return r
}

// Text is the payload's reading.
func (r *ProseReading) Text() string { return r.text }

// Resolve turns one edit into the cuts that apply it: the covered portion of
// every run its match crosses, in source order, with the replacement placed at
// the first of them.
//
// The anchor is the quote at its occurrence, counted at THE GRAIN THE EDIT
// DECLARES and resolved over the whole reading — the same reading, counted the
// same way, that the client resolves against to draw the mark. A grain nothing
// counts in is a malformed request; an anchor that simply is not there is
// stale.
func (r *ProseReading) Resolve(edit domain.TextEdit) ([]proseSplice, error) {
	segment := domain.TextSegment{Text: r.text}
	run, found, err := segment.Resolve(edit.Grain, edit.Quote, edit.Occurrence)
	if err != nil {
		return nil, fmt.Errorf("%w: prose: unknown text grain %q", block.ErrTextMalformed, edit.Grain)
	}
	if !found {
		return nil, fmt.Errorf("%w: %q at occurrence %d", block.ErrTextStale, edit.Quote, edit.Occurrence)
	}
	cuts, ok := r.cover(run.Start, run.End)
	if !ok {
		return nil, fmt.Errorf("%w: %q names no stored text of one block-level node", block.ErrTextStale, edit.Quote)
	}
	insertAt := cuts[0].start
	cuts = r.trimEmptiedPairs(cuts, insertAt, edit.Replacement)

	splices := make([]proseSplice, 0, len(cuts))
	for _, cut := range cuts {
		replacement := ""
		if cut.start == insertAt {
			replacement = edit.Replacement
		}
		splices = append(splices, proseSplice{start: cut.start, stop: cut.stop, replacement: replacement})
	}
	return splices, nil
}

// cover maps a span of the reading onto the stored bytes it was read from: one
// cut per run the span crosses, each holding only the part of that run the span
// actually covers.
//
// A span that touches no source at all — one made entirely of a softbreak's
// space — names nothing to write over, and so does one reaching across two
// block-level nodes: the bytes between them are structure the reader never saw,
// and a write over them would rewrite the document's shape rather than its
// words.
func (r *ProseReading) cover(start, stop int) ([]rawCut, bool) {
	var cuts []rawCut
	node := -1
	for _, run := range r.runs {
		if run.at >= stop || start >= run.end() {
			continue
		}
		if node < 0 {
			node = run.node
		} else if run.node != node {
			return nil, false
		}
		if !run.mapsByteForByte() {
			cuts = append(cuts, rawCut{start: run.raw, stop: run.rawStop})
			continue
		}
		from, to := max(start, run.at), min(stop, run.end())
		cuts = append(cuts, rawCut{start: run.raw + from - run.at, stop: run.raw + to - run.at})
	}
	return cuts, node >= 0
}

// trimEmptiedPairs adds the marker cuts of every wrapper this edit leaves with
// nothing inside it, repeating until none is left: emptying an inner pair can
// empty the one around it.
//
// A wrapper is emptied when the cuts cover ALL of its content and the
// replacement does not land within it — a replacement inserted inside the pair
// is its new content, and the pair stays. Only wrappers that proved their marker
// bytes are here at all, so the bytes this deletes are known to be markers.
func (r *ProseReading) trimEmptiedPairs(cuts []rawCut, insertAt int, replacement string) []rawCut {
	for {
		grew := false
		for _, w := range r.wrappers {
			if replacement != "" && insertAt >= w.contentStart && insertAt < w.contentStop {
				continue
			}
			if !r.covers(cuts, w.contentStart, w.contentStop) {
				continue
			}
			for _, marker := range []rawCut{{w.fullStart, w.contentStart}, {w.contentStop, w.fullStop}} {
				if marker.stop <= marker.start || r.covers(cuts, marker.start, marker.stop) {
					continue
				}
				cuts = append(cuts, marker)
				grew = true
			}
		}
		if !grew {
			slices.SortFunc(cuts, func(a, b rawCut) int { return a.start - b.start })
			return cuts
		}
	}
}

// covers reports whether the cuts leave no byte of [start,stop) standing.
func (r *ProseReading) covers(cuts []rawCut, start, stop int) bool {
	for at := start; at < stop; {
		moved := false
		for _, cut := range cuts {
			if cut.start <= at && at < cut.stop {
				at, moved = cut.stop, true
				break
			}
		}
		if !moved {
			return false
		}
	}
	return true
}

// collect walks the parse, appending each block-level node that directly holds
// inlines to the reading and recording where its characters came from. A node
// holding blocks — a list, a blockquote — is walked through: its text lives in
// the nodes it contains.
//
// A node that turns out to contribute NOTHING — a paragraph holding only an
// image with no alt text, say — is rolled back entirely, its joining newline
// included, so the reading never shows a blank line where nothing was read.
func (r *ProseReading) collect(parent ast.Node) {
	for child := parent.FirstChild(); child != nil; child = child.NextSibling() {
		if !r.bearsInlines(child) {
			r.collect(child)
			continue
		}
		mark, runsBefore := len(r.buf), len(r.runs)
		r.softbreak = -1
		if len(r.buf) > 0 {
			r.buf = append(r.buf, '\n')
		}
		lines := child.Lines()
		r.nodes = append(r.nodes, nodeBounds{
			rawStart: lines.At(0).Start,
			rawStop:  lines.At(lines.Len() - 1).Stop,
		})
		r.cursor = lines.At(0).Start
		r.appendInlines(child)
		r.closeSoftbreak(r.nodes[len(r.nodes)-1].rawStop)
		if len(r.runs) == runsBefore {
			r.buf = r.buf[:mark]
			r.nodes = r.nodes[:len(r.nodes)-1]
		}
	}
}

// bearsInlines reports whether n is a block whose children are the inline
// leaves a reading is made of. A fence and an html block keep their content in
// lines rather than children, so they answer false and contribute nothing.
func (r *ProseReading) bearsInlines(n ast.Node) bool {
	first := n.FirstChild()
	return n.Type() == ast.TypeBlock && first != nil && first.Type() == ast.TypeInline &&
		n.Lines() != nil && n.Lines().Len() > 0
}

// appendInlines walks n's inline children into b, recording a run for every
// stretch that came from source and a wrapper for every marked-up node it
// descends through.
func (r *ProseReading) appendInlines(n ast.Node) {
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		switch v := child.(type) {
		case *ast.Text:
			r.appendRun(v.Segment.Start, v.Segment.Stop)
			switch {
			case v.HardLineBreak():
				// A hard break is deliberate structure rather than a space a reader
				// could match through, so its newline names no source and no write
				// reaches it.
				r.buf = append(r.buf, '\n')
			case v.SoftLineBreak():
				r.appendSoftbreak(v.Segment.Stop)
			}
		case *ast.AutoLink:
			r.appendAutoLink(v)
		case *ast.RawHTML:
			// A tag the surface interprets rather than draws. Its bytes are still
			// stepped over, so an autolink after it is searched for past it.
			if segments := v.Segments; segments != nil && segments.Len() > 0 {
				r.cursor = max(r.cursor, segments.At(segments.Len()-1).Stop)
			}
		case *ast.String:
			// A generated string names no bytes a splice could be placed in.
		default:
			before := len(r.runs)
			r.appendInlines(child)
			if len(r.runs) > before {
				r.noteWrapper(child, r.runs[before].raw, r.runs[len(r.runs)-1].rawStop)
			} else {
				r.stepOverEmptyPair(child)
			}
		}
	}
}

// stepOverEmptyPair advances the cursor past a link or image whose content
// reached the reading as NOTHING — `![](url)`. What follows its brackets is a
// destination, spelled in one form exactly like an autolink, so a search
// starting before it could take those bytes for text the reader saw.
//
// It records NO wrapper. A pair with no content is emptied by every edit
// vacuously, so one recorded here would lose its markers to a spend somewhere
// else in the same node. The markers are still proved, and a pair that cannot
// prove them leaves the cursor where it was.
func (r *ProseReading) stepOverEmptyPair(n ast.Node) {
	var lead int
	switch n.(type) {
	case *ast.Link:
		lead = 1
	case *ast.Image:
		lead = 2
	default:
		return
	}
	bounds := r.nodes[len(r.nodes)-1]
	if r.cursor >= bounds.rawStop {
		return
	}
	at := bytes.Index(r.source[r.cursor:bounds.rawStop], []byte("[]"))
	if at < 0 {
		return
	}
	content := r.cursor + at + 1
	if _, fullStop, ok := r.bracketMarkers(bounds, content, content, lead); ok {
		r.cursor = fullStop
	}
}

// appendAutoLink reads an autolink as the ADDRESS between its brackets — what
// the surface draws — leaving `<` and `>` as markers no cut reaches.
//
// The node does not carry its own bounds, so the address is FOUND: the bracketed
// form is searched for from where the node has been read to, and the run is
// recorded only when those exact bytes are there. An autolink whose bytes cannot
// be pointed at contributes nothing, which is what any unmappable leaf does.
func (r *ProseReading) appendAutoLink(n *ast.AutoLink) {
	label := n.Label(r.source)
	if len(label) == 0 {
		return
	}
	bounds := r.nodes[len(r.nodes)-1]
	if r.cursor >= bounds.rawStop {
		return
	}
	needle := make([]byte, 0, len(label)+2)
	needle = append(append(append(needle, '<'), label...), '>')
	at := bytes.Index(r.source[r.cursor:bounds.rawStop], needle)
	if at < 0 {
		return
	}
	contentStart := r.cursor + at + 1
	r.appendRun(contentStart, contentStart+len(label))
	r.noteWrapper(n, contentStart, contentStart+len(label))
}

// appendRun copies source[start:stop) into the reading and records where it
// came from.
func (r *ProseReading) appendRun(start, stop int) {
	r.closeSoftbreak(start)
	if stop <= start || start < 0 || stop > len(r.source) {
		return
	}
	r.runs = append(r.runs, readingRun{
		at: len(r.buf), length: stop - start, raw: start, rawStop: stop, node: len(r.nodes) - 1,
	})
	r.buf = append(r.buf, r.source[start:stop]...)
	r.cursor = stop
}

// appendSoftbreak reads a line ending as ONE SPACE, and maps that space onto the
// line ending itself.
//
// THIS IS THE ONE PLACE THE READING DELIBERATELY DIFFERS FROM THE SOURCE. A soft
// line break is not structure a reader can see — a surface draws the two lines
// as one flowing sentence with a space between them — so the reading must show a
// space, or a search for a phrase spanning the break would never match. Making
// that space a RUN over the break's own bytes is what lets a match that covers
// it rewrite the break: replacing across the break joins the lines, which is
// what replacing a phrase does in anything that wraps text.
//
// The span it maps to reaches from the end of the text before it to the start of
// the text after — the trailing whitespace, the newline, and the next line's
// indentation, none of which the reader saw. closeSoftbreak fixes that end once
// the next run is known.
func (r *ProseReading) appendSoftbreak(from int) {
	r.softbreak = len(r.runs)
	r.runs = append(r.runs, readingRun{
		at: len(r.buf), length: 1, raw: from, rawStop: from, node: len(r.nodes) - 1,
	})
	r.buf = append(r.buf, ' ')
}

// closeSoftbreak ends an open substitution run at the next text to be read, or
// drops it when the break turns out to name no bytes at all — leaving its space
// in the reading as a character no write can reach, which is what any unmapped
// character is.
func (r *ProseReading) closeSoftbreak(nextRawStart int) {
	if r.softbreak < 0 {
		return
	}
	open := r.softbreak
	r.softbreak = -1
	if nextRawStart > r.runs[open].raw {
		r.runs[open].rawStop = nextRawStart
		return
	}
	r.runs = r.runs[:open]
}

// noteWrapper records n's markers when they can be bounded exactly. A node
// whose markers cannot be — a reference form this does not read, a span the
// source does not confirm — is simply not recorded: a wrapper is a licence to
// widen a splice, and one that is not certain of its own extent must not grant
// it.
func (r *ProseReading) noteWrapper(n ast.Node, contentStart, contentStop int) {
	fullStart, fullStop, ok := r.markerSpan(n, contentStart, contentStop)
	if !ok {
		return
	}
	// A proved span is the whole of the node's source, so it is also how far the
	// node has been dealt with. A destination or a title is spelled in bytes the
	// reading never showed — an angle-form destination is spelled EXACTLY like an
	// autolink — and anything searching forward from here must start past them.
	r.cursor = max(r.cursor, fullStop)
	r.wrappers = append(r.wrappers, inlineWrapper{
		contentStart: contentStart, contentStop: contentStop,
		fullStart: fullStart, fullStop: fullStop,
	})
}

// markerSpan bounds n's whole source, markers included, given the bounds of the
// content that reached the reading — and PROVES the marker bytes it claims.
//
// The content bounds come from the first and last child that contributed to the
// reading, which is not the same thing as the node's own extent: an edge child
// may have contributed nothing (raw html) or only part of itself (an autolink,
// whose brackets are its own markers), so the bytes just outside the content are
// that child's, not a marker. Every case below therefore reads what it is about
// to claim and refuses unless it is exactly the marker it expects.
func (r *ProseReading) markerSpan(n ast.Node, contentStart, contentStop int) (int, int, bool) {
	bounds := r.nodes[len(r.nodes)-1]
	switch v := n.(type) {
	case *ast.Emphasis:
		return r.emphasisMarkers(bounds, contentStart, contentStop, v.Level)
	case *ast.CodeSpan:
		return r.codeSpanMarkers(bounds, contentStart, contentStop)
	case *ast.Link:
		return r.bracketMarkers(bounds, contentStart, contentStop, 1)
	case *ast.Image:
		return r.bracketMarkers(bounds, contentStart, contentStop, 2)
	case *ast.AutoLink:
		return r.angleMarkers(bounds, contentStart, contentStop)
	}
	return 0, 0, false
}

// emphasisMarkers claims level runs of one emphasis character each side, and
// only when every byte it claims IS that character.
func (r *ProseReading) emphasisMarkers(bounds nodeBounds, contentStart, contentStop, level int) (int, int, bool) {
	start, stop := contentStart-level, contentStop+level
	if level < 1 || start < bounds.rawStart || stop > bounds.rawStop {
		return 0, 0, false
	}
	marker := r.source[contentStart-1]
	if marker != '*' && marker != '_' {
		return 0, 0, false
	}
	for i := start; i < contentStart; i++ {
		if r.source[i] != marker {
			return 0, 0, false
		}
	}
	for i := contentStop; i < stop; i++ {
		if r.source[i] != marker {
			return 0, 0, false
		}
	}
	return start, stop, true
}

// angleMarkers claims the one bracket each side of an autolink's address, and
// only when both are there: an address emptied by an edit takes its brackets
// with it rather than leaving `<>` standing.
func (r *ProseReading) angleMarkers(bounds nodeBounds, contentStart, contentStop int) (int, int, bool) {
	if contentStart-1 < bounds.rawStart || contentStop >= bounds.rawStop {
		return 0, 0, false
	}
	if r.source[contentStart-1] != '<' || r.source[contentStop] != '>' {
		return 0, 0, false
	}
	return contentStart - 1, contentStop + 1, true
}

// codeSpanMarkers walks the backtick runs either side of a code span's content,
// stepping over the one space each side that a code span's own reading strips.
// Every byte it claims is read; runs of unequal length are not this span's
// delimiters, so nothing is claimed.
func (r *ProseReading) codeSpanMarkers(bounds nodeBounds, contentStart, contentStop int) (int, int, bool) {
	start := contentStart
	if start > bounds.rawStart && r.source[start-1] == ' ' {
		start--
	}
	opening := 0
	for start > bounds.rawStart && r.source[start-1] == '`' {
		start--
		opening++
	}
	stop := contentStop
	if stop < bounds.rawStop && r.source[stop] == ' ' {
		stop++
	}
	closing := 0
	for stop < bounds.rawStop && r.source[stop] == '`' {
		stop++
		closing++
	}
	if opening == 0 || opening != closing {
		return 0, 0, false
	}
	return start, stop, true
}

// bracketMarkers bounds a link or an image: lead is how many characters open it
// ("[" alone, or "![" for an image). The brackets either side of the text are
// read rather than assumed, and what follows decides the rest — a parenthesised
// destination is closed by its balanced parenthesis, a reference by its closing
// bracket, and a shortcut reference by the label's own bracket.
func (r *ProseReading) bracketMarkers(bounds nodeBounds, contentStart, contentStop, lead int) (int, int, bool) {
	start := contentStart - lead
	if start < bounds.rawStart || r.source[contentStart-1] != '[' {
		return 0, 0, false
	}
	if lead == 2 && r.source[start] != '!' {
		return 0, 0, false
	}
	if contentStop >= bounds.rawStop || r.source[contentStop] != ']' {
		return 0, 0, false
	}
	stop := contentStop + 1
	if stop >= bounds.rawStop {
		return start, stop, true
	}
	switch r.source[stop] {
	case '(':
		end, ok := r.destinationEnd(bounds, stop)
		return start, end, ok
	case '[':
		for i := stop + 1; i < bounds.rawStop; i++ {
			if r.source[i] == ']' {
				return start, i + 1, true
			}
		}
		return 0, 0, false
	}
	return start, stop, true
}

// destinationEnd returns one past the parenthesis closing the destination that
// begins at open.
//
// A TITLE IS SKIPPED WHOLE. Markdown allows a quoted title inside the
// parentheses, and a title may contain a parenthesis of its own — counting
// parentheses through one would close the destination early and claim a marker
// span that stops in the middle of the user's text.
func (r *ProseReading) destinationEnd(bounds nodeBounds, open int) (int, bool) {
	depth := 0
	for i := open; i < bounds.rawStop; i++ {
		switch c := r.source[i]; c {
		case '\\':
			i++
		case '"', '\'':
			closed := false
			for i++; i < bounds.rawStop; i++ {
				if r.source[i] == '\\' {
					i++
					continue
				}
				if r.source[i] == c {
					closed = true
					break
				}
			}
			if !closed {
				return 0, false
			}
		case '(':
			depth++
		case ')':
			if depth--; depth == 0 {
				return i + 1, true
			}
		}
	}
	return 0, false
}

// end is one past the run's last reading byte.
func (run readingRun) end() int { return run.at + run.length }

// mapsByteForByte reports whether this run's reading and its source are the same
// bytes, so a part of one names the matching part of the other. A substitution
// run answers false and is only ever taken whole.
func (run readingRun) mapsByteForByte() bool { return run.rawStop-run.raw == run.length }
