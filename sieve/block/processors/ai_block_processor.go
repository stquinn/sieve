package processors

import (
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// AIBlockProcessor implements BlockProcessor for the "ai-block" kind.
type AIBlockProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewAIBlockProcessor(svc block.BlockServices) *AIBlockProcessor {
	return &AIBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "ai-block"}}
}

func (p *AIBlockProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *AIBlockProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

// InitAttrs seeds a new ai-block: the envelope a turn is answered into, and
// nothing about the question.
//
// THE QUESTION IS THE COMPOSER'S TO COMPOSE. It arrives in the overrides as the
// element list under block.QuestionAttr, already carrying its targets and its
// attachments as reference elements; there is no default question, because a
// question that is not there is never invented. An ai-block with no list at all
// is the detached class, and the absence IS the observable.
//
// EVERY ELEMENT IS IDENTIFIED HERE, exactly as the block itself is: the composer
// mints no element ids, so the list arrives id-less and this is the model's
// entrance. Identifying it later is not equivalent — the first fold of a new ask
// reads its question out of a job snapshot that shares the payload with the live
// tree, and would be minting into it without the document's lock.
func (p *AIBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusPending,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"response":          "",
		"type":              "ASK",
		"model":             "",
		"error":             "",
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	block.MintElementIDs(attrs, block.QuestionAttr)
	return attrs
}

// IsSupportedContent claims an ai-block in either of the two forms one can be
// carried in: the sieve/ai-block clipboard view an in-app copy puts on the
// clipboard, and the ```ai-block fence — the block's own serialized form, which
// is what a copy out of markdown mode (or out of the file on disk) produces.
func (p *AIBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) || p.WrapsAnyShape(e.Content) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// Transform recovers the pasted block's attrs — from whichever of the two forms
// carried it. Either way the result is a NEW block: the framework mints its id,
// so the pasted one is dropped rather than duplicated into the document.
func (p *AIBlockProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		if attrs := p.attrsFromFence(e.Content); attrs != nil {
			return attrs
		}
	}
	return nil
}

// attrsFromFence reads a pasted ```ai-block fence through the deserializer this
// processor already embeds — the same one the document load path uses — so the
// paste never grows a second parser for bytes that already have one.
//
// The id goes, because this is a new block. So do the aliases, which Deserialize
// lifts off the attrs for us: an alias is a name inside ONE document, given by a
// deliberate act, and a copy inherits neither the name nor the act.
func (p *AIBlockProcessor) attrsFromFence(content string) map[string]interface{} {
	span := strings.TrimSpace(content)
	if !p.WrapsAnyShape(span) {
		return nil
	}
	blocks, err := p.Deserialize(block.Region{Kind: p.Kind(), Raw: span})
	if err != nil || len(blocks) == 0 {
		return nil
	}
	attrs := blocks[0].Attrs
	delete(attrs, "id")
	return attrs
}

func (p *AIBlockProcessor) OnChange(blk *block.SieveBlock) {}

// Children returns the ordered blocks this block's question is composed of — the
// BlockParent capability. They are elements: they live in this block's payload
// and nowhere else, so nothing in the document tree addresses them.
func (p *AIBlockProcessor) Children(blk *block.SieveBlock) []*block.SieveBlock {
	return blk.Elements(block.QuestionAttr)
}

// aiBlockLabel is the in-flight status label for an ai-block job.
func (p *AIBlockProcessor) aiBlockLabel(blk *block.SieveBlock) string {
	if t, _ := blk.Attrs["type"].(string); t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// qaHeader renders the QUESTION-side of this block's Q&A WITHOUT its own answer:
// "EXPLAIN NODE: <ref>" or "QUESTION ABOUT: <ref>\n<question>", followed by this
// turn's ATTACHED DOCUMENTS section when it has one. It is the ACTION
// assembly — the block being asked must never carry its own prior `response`, or a
// retry (where the doc snapshot already holds a stale answer) biases the new answer.
// BuildContext (THREAD / ref-chain / target callers) calls this then appends the
// answer, because the conversation history MUST keep prior answers.
//
// THIS IS THE ATTACHMENTS SEAM, and it is per-TURN: attachments belong to a
// question, and this is the one place a question is rendered, so every turn in a
// thread carries the documents it was given. The order falls out — QUESTION,
// then ATTACHED DOCUMENTS, then the answer BuildContext appends.
func (p *AIBlockProcessor) qaHeader(blk block.SieveBlock, doc block.DocView) string {
	q := p.foldQuestion(blk, doc)
	t, _ := blk.Attrs["type"].(string)

	var sb strings.Builder
	if t == "EXPLAIN" {
		sb.WriteString("EXPLAIN NODE: ")
		sb.WriteString(q.targets.names())
	} else {
		sb.WriteString("QUESTION ABOUT: ")
		sb.WriteString(q.targets.names())
		if text := strings.TrimSpace(p.questionText(q.body, doc)); text != "" {
			sb.WriteString("\n")
			sb.WriteString(text)
		}
	}
	return q.attachments.AppendTo(sb.String())
}

// questionSlots is an ai-block's question list folded into the three parts
// prompt assembly renders it in: the targets it is ABOUT, the blocks it IS, and
// the documents it was HANDED.
type questionSlots struct {
	targets questionTargets
	// body is every non-reference element, in list order, whatever its kind.
	body []*block.SieveBlock
	// attachments is the per-turn manifest the reference elements describe.
	attachments domain.Attachments
}

// questionTargets is a question's target slot: the reference elements naming
// what the question is ABOUT, and the container they are named against.
//
// Whether an element belongs in this slot, what the local chain calls it and
// what a walk keys its cycle guard on are the same question asked three ways,
// so all three live here and nowhere else.
type questionTargets struct {
	// own is the live address of the container the question lives in — what
	// "in this document" is measured against.
	own domain.Address
	els []*block.SieveBlock
}

// targets is THE target seam: which of blk's question elements name material it
// is ABOUT. The fold's target slot and the chain walk both read it, so the
// target predicate has exactly one home.
func (p *AIBlockProcessor) targets(blk block.SieveBlock, doc block.DocView) questionTargets {
	return p.foldQuestion(blk, doc).targets
}

// foldQuestion reads blk's question list into the three slots. doc names the
// container blk lives in — the naming authority an element address is
// classified against — and is forwarded to the element renderers.
//
// EVERY NON-REFERENCE ELEMENT IS THE QUESTION, whatever its kind: the body slot
// has no per-kind arm and never will.
//
// A reference element declares its ROLE in `rel`, and the role decides the slot:
// RelTarget is material the question is about, RelAttach is material the turn
// was handed. When `rel` declares neither, the address decides — inside this
// container is a target, anywhere else (an address elsewhere, or one the grammar
// rejects) is an attachment.
//
// A list with no target element at all is a DETACHED question — one about
// nothing — and is distinct from a question about the whole document.
func (p *AIBlockProcessor) foldQuestion(blk block.SieveBlock, doc block.DocView) questionSlots {
	q := questionSlots{targets: questionTargets{own: domain.NewContainerAddress(doc.UUID)}}
	for _, el := range blk.Elements(block.QuestionAttr) {
		switch {
		case el.Kind != block.KindReference:
			q.body = append(q.body, el)
		case q.targets.isTarget(el):
			q.targets.els = append(q.targets.els, el)
		default:
			q.attachments = append(q.attachments, domain.Attachment{
				URI:   el.StringAttr("uri"),
				Title: el.FaceString("title"),
			})
		}
	}
	return q
}

// isTarget reports whether el is material the question is ABOUT rather than
// material it was HANDED.
func (t questionTargets) isTarget(el *block.SieveBlock) bool {
	switch el.StringAttr("rel") {
	case block.RelTarget:
		return true
	case block.RelAttach:
		return false
	}
	_, local := t.localToken(el)
	return local
}

// localToken returns the handle THIS container's chain resolves el by — the
// whole-document sentinel for own itself, the leaf for a block inside it — and
// whether el has one at all.
//
// A target naming another container has none, and neither does one whose
// address the grammar rejects: the chain walks handles within a single
// container, and neither of those is one.
func (t questionTargets) localToken(el *block.SieveBlock) (string, bool) {
	addr, err := domain.ParseAddress(el.StringAttr("uri"))
	switch {
	case err != nil:
		return "", false
	case addr.Equal(t.own):
		return block.WholeDocumentRef, true
	case addr.ContainerAddress().Equal(t.own):
		return addr.Leaf, true
	default:
		return "", false
	}
}

// address is el's canonical coordinate — what a walk keys its cycle guard on,
// because a chain can now name nodes in more than one container and a bare
// handle no longer identifies one. An address the grammar rejects keys on
// itself: it names nothing, but it is still the same nothing on a second visit.
func (t questionTargets) address(el *block.SieveBlock) string {
	uri := el.StringAttr("uri")
	if addr, err := domain.ParseAddress(uri); err == nil {
		return addr.String()
	}
	return uri
}

// names spells the slot the way the header does: a local target by the handle
// the chain resolves it by, any other by the address it carries, comma-separated
// in list order.
func (t questionTargets) names() string {
	out := make([]string, 0, len(t.els))
	for _, el := range t.els {
		if token, local := t.localToken(el); local {
			out = append(out, token)
		} else {
			out = append(out, el.StringAttr("uri"))
		}
	}
	return strings.Join(out, ",")
}

// elementContexts renders elements through the registered per-kind AI seam, in
// list order — the ONE way an element becomes prompt text, so a question or a
// target composed of any kind reads the way that kind reads to a model.
//
// THE NODE ID IS DROPPED. A provider names the block it renders, and an element
// is not in the document tree: nothing resolves its id, so publishing one would
// hand the model a handle it cannot use. What a reference element IS reachable
// by — its address — the reference kind already renders as a trailer.
//
// doc is forwarded to each provider as the snapshot it renders against; an
// element is not in that tree, so a provider resolving ids finds nothing there.
func (p *AIBlockProcessor) elementContexts(els []*block.SieveBlock, doc block.DocView) []block.AIContext {
	out := make([]block.AIContext, 0, len(els))
	for _, el := range els {
		cp := block.GetContextProvider(el.Kind)
		if cp == nil {
			logger.Warn("ai-block: no provider registered for element kind", "kind", el.Kind)
			continue
		}
		ctx := cp.BuildContext(*el, doc, map[string]bool{})
		ctx.NodeIDs = nil
		out = append(out, ctx)
	}
	return out
}

// questionText renders the body slot: the merged CONTENT of its elements. A
// trailer is dropped with it — it belongs to the block it was extracted from,
// not to the question asking about that block.
func (p *AIBlockProcessor) questionText(body []*block.SieveBlock, doc block.DocView) string {
	return block.MergeContexts(p.elementContexts(body, doc)).Content
}

// BuildContext returns a Q&A summary for when this block appears in another block's
// ref chain. The NODE ID header is rendered by AIContext.String (from NodeIDs); the
// QUESTION ABOUT / EXPLAIN NODE line stays in Content because it is a header before
// the Q&A, not a mergeable trailer. Unlike the ACTION assembly (qaHeader) this DOES
// append the block's own answer — a ref-chain / THREAD entry is conversation history.
func (p *AIBlockProcessor) BuildContext(blk block.SieveBlock, doc block.DocView, seen map[string]bool) block.AIContext {
	r, _ := blk.Attrs["response"].(string)
	t, _ := blk.Attrs["type"].(string)

	sb := strings.Builder{}
	sb.WriteString(p.qaHeader(blk, doc))
	if r != "" {
		if t == "EXPLAIN" {
			sb.WriteString("\n**ANSWER:** ")
		} else {
			sb.WriteString("\n\n**ANSWER:** ")
		}
		sb.WriteString(strings.TrimSpace(r))
	}

	return block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
}

// chainWalk is the target graph resolved: the terminal MANY the chain bottoms
// out at, split by WHERE each member lives, plus the interior nodes between the
// action block and it.
type chainWalk struct {
	// local are the handles of terminal nodes in this container — the
	// whole-document sentinel, or a block id.
	local []string
	// foreign are the terminal targets naming another container.
	foreign []*block.SieveBlock
	// thread is the interior nodes, oldest-first. All local, because the walk
	// does not cross a container boundary.
	thread []string
}

// resolveChain walks the point-to-point target graph from blk and classifies
// each reachable node by GEOMETRY, not type: a node with targets of its own is
// INTERIOR — part of the THREAD (the conversation/derivation history) — and is
// recursed into; a node with none is a LEAF — part of the TARGET, the terminal
// MANY the chain bottoms out at. The whole-document target is a leaf. thread is
// returned oldest-first (the deepest interior node is the oldest). Type never
// enters the decision, so a future DATA → GRAPH → AI chain classifies correctly
// with no change.
//
// THE WALK STOPS AT THE CONTAINER BOUNDARY. A target naming another container
// is terminal however deep its own history runs: descending would read a foreign
// document to compose a prompt, and nothing foreign is read at composition time.
// It renders in place as the reference it is, and the model follows it through
// the MCP verb if it wants what is behind it.
//
// The seen-guard keys on each node's CANONICAL ADDRESS rather than its bare
// handle — a chain can name nodes in more than one container, where a bare
// handle no longer identifies one — and makes cyclic graphs terminate.
func (p *AIBlockProcessor) resolveChain(blk block.SieveBlock, doc block.DocView) chainWalk {
	var w chainWalk
	seen := map[string]bool{}
	if blk.ID != "" {
		seen[domain.NewLeafAddress(doc.UUID, blk.ID).String()] = true
	}
	var descend func(t questionTargets)
	descend = func(t questionTargets) {
		for _, el := range t.els {
			key := t.address(el)
			if seen[key] {
				continue
			}
			seen[key] = true

			token, local := t.localToken(el)
			if !local {
				w.foreign = append(w.foreign, el)
				continue
			}
			if token == block.WholeDocumentRef {
				w.local = append(w.local, token)
				continue
			}
			child, ok := doc.GetBlock(token)
			if !ok {
				w.local = append(w.local, token)
				continue
			}
			if next := p.targets(*child, doc); len(next.els) == 0 {
				w.local = append(w.local, token) // leaf → target
			} else {
				w.thread = append(w.thread, token) // interior → thread
				descend(next)
			}
		}
	}
	descend(p.targets(blk, doc))
	for i, j := 0, len(w.thread)-1; i < j; i, j = i+1, j-1 {
		w.thread[i], w.thread[j] = w.thread[j], w.thread[i] // shallow-first → oldest-first
	}
	return w
}

// buildTargets renders the terminal MANY by asking each member for its AIContext
// and MERGING them into one — node ids concat into a single header, contents
// append, and the "Specifically regarding" trailers union into ONE focus line.
// Type-agnostic: a multi-block selection, a single block, or "doc" all merge the
// same way; empty contexts drop out.
//
// The MANY has two kinds of member and one merge. A member in THIS document is
// resolved by handle (BuildContextForID) and its content is inlined. A member
// elsewhere is a foreign element that resolves to nothing here, so it renders as
// the reference it is — address plus cached face — and the model dereferences it
// through the MCP verb if it needs the content.
func (p *AIBlockProcessor) buildTargets(w chainWalk, doc block.DocView) string {
	var ctxs []block.AIContext
	// Exclude this processor's own kind: when a target is the whole doc, its derived
	// markdown must not carry prior ai-block answers — an ai-block serializes as its
	// raw YAML fence (question + response), and including prior answers makes the
	// model fixate on its own stale output and resurrect document text quoted inside
	// old answers. THREAD (a separate slot) still carries the conversation. A
	// specific-block target ignores the filter (returned as-is).
	noSelfKind := func(b block.SieveBlock) bool { return b.Kind != p.Kind() }
	for _, id := range w.local {
		if c := block.BuildContextForID(id, doc, map[string]bool{}, noSelfKind); !c.IsEmpty() {
			ctxs = append(ctxs, c)
		}
	}
	for _, c := range p.elementContexts(w.foreign, doc) {
		if !c.IsEmpty() {
			ctxs = append(ctxs, c)
		}
	}
	return block.MergeContexts(ctxs).String()
}

// buildPrompt assembles the three prompt slots from the immutable job snapshot,
// splitting the ref graph by GEOMETRY (resolveChain):
//
//   - content — the TARGET: the terminal MANY of leaf nodes, the material being
//     asked about.
//   - history — the THREAD: the interior nodes oldest-first, each rendered as
//     its own Q&A entry (NOT merged — distinct entries keeping their own
//     trailers, and their own attachments).
//   - question — the ACTION: this block's own question-side. It must NOT carry
//     its own prior `response`: on a retry the doc snapshot already holds a
//     stale answer, and leaking it into the ACTION biases the new one. The NODE
//     ID header is preserved via NodeIDs.
//
// Split out of DescribeJob so the assembled prompt is assertable without running
// a job or reaching a CLI.
func (p *AIBlockProcessor) buildPrompt(blk *block.SieveBlock, doc block.DocView) (content, history, question string) {
	w := p.resolveChain(*blk, doc)

	content = p.buildTargets(w, doc)

	seen := map[string]bool{blk.ID: true}
	var historyParts []string
	for _, id := range w.thread {
		// THREAD resolution is untouched (nil filter): interior nodes are ai-blocks
		// resolved by id — the conversation history must keep prior answers verbatim.
		if ctx := block.BuildContextForID(id, doc, seen, nil); !ctx.IsEmpty() {
			historyParts = append(historyParts, ctx.String())
		}
	}
	history = strings.Join(historyParts, "\n\n---\n\n")

	question = block.AIContext{NodeIDs: []string{blk.ID}, Content: p.qaHeader(*blk, doc)}.String()
	return content, history, question
}

// DescribeJob builds the prompt by walking this block's point-to-point ref graph and
// splitting it by GEOMETRY (resolveChain): the terminal MANY of leaf nodes is the
// TARGET (the content being asked about), the interior nodes are the THREAD (prior
// Q&A / derivation history), and this block is the ACTION. Each node self-describes
// through the registry (BuildContextForID), so dispatch stays kind-agnostic. The
// prompt is assembled synchronously here (it needs the immutable jctx.Doc snapshot),
// then captured by Work; Apply writes the success attrs. An ai-block always has
// async work (born PENDING), so DescribeJob never returns nil. The error path
// (status ERROR/TIMEOUT) is the framework's job in EditorService.finish, so Apply
// is success-only.
func (p *AIBlockProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	uuid := jctx.UUID
	blockType, _ := blk.Attrs["type"].(string)

	content, history, questionCtx := p.buildPrompt(blk, jctx.Doc)

	isExplain := blockType == "EXPLAIN"
	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    p.aiBlockLabel(blk),
		Work: func() (any, error) {
			if isExplain {
				return p.svc.AI.RunExplain(content, history, questionCtx, uuid)
			}
			return p.svc.AI.RunAsk(content, history, questionCtx, uuid)
		},
		Apply: func(result any, b *block.SieveBlock) {
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["response"] = result.(string)
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
		},
	}
}

// MarkdownRepresentation renders an ANSWERED exchange as ordinary document
// markdown — the one form behind both "Embed in Document" (the prose processor's
// Transform asks for it) and the markdown export (DocView.renderBlockExport asks
// for it), so what a person embeds is what a document exports.
//
// THE TWO REFERENCE ROLES LEAVE BY DIFFERENT DOORS, and the difference is what
// each one IS to the exchange:
//
//   - a TARGET is ABOUTNESS. It names material the document already holds, so
//     the embedded copy sits beside it and a pointer would deposit a bare
//     coordinate where the reader expects prose. Omitted.
//   - an ATTACHMENT is MATERIAL THE TURN WAS HANDED, and usually material the
//     document does NOT hold. Dropping it loses the provenance of the answer, so
//     it survives as a markdown link — its cached title the text, its address
//     the destination — and stays followable from wherever the exchange is
//     embedded.
//
// THE HEADING IS ONE LINE OR THERE IS NO HEADING. An ATX heading ends at the
// first newline, so an element whose rendering opens a fence can never sit on
// one: a question leading with code or a log renders its body from the top and
// the exchange is titled by its answer's position instead.
func (p *AIBlockProcessor) MarkdownRepresentation(blk block.SieveBlock, uuid string) string {
	status, _ := blk.Attrs["status"].(string)
	response, _ := blk.Attrs["response"].(string)
	response = strings.TrimSpace(response)
	if status != block.BlockStatusComplete || response == "" {
		return ""
	}
	doc := block.DocView{UUID: uuid}
	q := p.foldQuestion(blk, doc)
	heading, rest := p.embedHeading(q.body)

	var parts []string
	if heading != "" {
		parts = append(parts, "### "+heading)
	}
	if body := strings.TrimSpace(p.questionText(rest, doc)); body != "" {
		parts = append(parts, body)
	}
	parts = append(parts, p.embedAttachments(q.attachments)...)
	return strings.Join(append(parts, response), "\n\n")
}

// embedAttachments renders each attached document as one markdown link, in list
// order — a paragraph apiece, so the links read as separate provenance marks in
// every renderer rather than running together on one line.
//
// The link TEXT is the cached title, falling back to the address when there is
// none: a link with no text is unclickable in most renderers, and an address is
// always something. An attachment with no address at all is not a coordinate and
// renders nothing.
//
// BOTH HALVES ARE HOSTILE INPUT. A title is whatever a document was called or a
// model wrote, and an address's leaf may be an asset key — a filename, spaces
// and brackets included. This function's whole contract is well-formed markdown,
// so neither is interpolated raw.
func (p *AIBlockProcessor) embedAttachments(as domain.Attachments) []string {
	out := make([]string, 0, len(as))
	for _, a := range as {
		uri := strings.TrimSpace(a.URI)
		if uri == "" {
			continue
		}
		text := strings.TrimSpace(a.Title)
		if text == "" {
			text = uri
		}
		out = append(out, "["+linkTextEscaper.Replace(text)+"]("+linkDestination(uri)+")")
	}
	return out
}

// linkDestination renders a URI as a markdown link destination.
//
// A destination that carries none of what would end it early is emitted BARE,
// which is what an ordinary coordinate is and what a person reads most easily.
// One that does goes in angle brackets — CommonMark's own production for a
// destination containing spaces or parentheses — with the brackets themselves
// escaped inside it. A newline is DROPPED rather than escaped: no destination
// production spans lines, so a URI carrying one is already not a coordinate.
func linkDestination(uri string) string {
	if !strings.ContainsAny(uri, " \t\n\r()<>\\") {
		return uri
	}
	return "<" + linkDestEscaper.Replace(uri) + ">"
}

// linkTextEscaper escapes what would close a link's text early. The backslash
// itself goes first, so an escape this adds is never escaped again.
var linkTextEscaper = strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`)

// linkDestEscaper escapes what would close an angle-bracket destination early.
var linkDestEscaper = strings.NewReplacer(`\`, `\\`, "<", `\<`, ">", `\>`, "\n", "", "\r", "")

// embedHeading lifts the title of an embedded exchange off the question's body:
// the first line of its leading prose element, and the elements left to render
// under it in authored order.
//
// Only the LEADING element is ever a candidate, so nothing is reordered. A body
// leading with anything else — or with prose whose first line is blank — is
// titleless and renders whole.
func (p *AIBlockProcessor) embedHeading(body []*block.SieveBlock) (string, []*block.SieveBlock) {
	if len(body) == 0 || body[0].Kind != block.KindProse {
		return "", body
	}
	head, rest, _ := strings.Cut(strings.TrimSpace(body[0].StringAttr("content")), "\n")
	if head = strings.TrimSpace(head); head == "" {
		return "", body
	}
	if strings.TrimSpace(rest) == "" {
		return head, body[1:]
	}
	remainder := block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": rest})
	return head, append([]*block.SieveBlock{&remainder}, body[1:]...)
}
