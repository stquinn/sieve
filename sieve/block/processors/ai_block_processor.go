package processors

import (
	"strings"
	"time"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/ai"
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
	return &AIBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: block.KindAIBlock}}
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
// tree, and would be minting into it without the document's lock. The answer
// slot is identified at the same door: creation seeds no answer, but a paste and
// a transform both arrive carrying one.
func (p *AIBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusPending,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
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
	domain.MintElementIDs(attrs, block.QuestionAttr)
	domain.MintElementIDs(attrs, block.AnswerAttr)
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
// The id goes, because this is a new block, and every element gets a new one for
// the same reason. So do the aliases, which Deserialize lifts off the attrs for
// us: an alias is a name inside ONE document, given by a deliberate act, and a
// copy inherits neither the name nor the act.
func (p *AIBlockProcessor) attrsFromFence(content string) map[string]interface{} {
	span := strings.TrimSpace(content)
	if !p.WrapsAnyShape(span) {
		return nil
	}
	blocks, err := p.Deserialize(block.Region{Kind: p.Kind(), Raw: span})
	if err != nil || len(blocks) == 0 {
		return nil
	}
	for _, el := range p.Children(&blocks[0]) {
		el.Reidentify(ident.New())
	}
	attrs := blocks[0].Attrs
	delete(attrs, "id")
	return attrs
}

func (p *AIBlockProcessor) OnChange(blk *domain.SieveBlock) {}

// Children returns the ordered blocks this exchange is composed of — the
// BlockParent capability. The question's elements come first, then the answer's:
// both slots hold elements, which live in this block's payload and nowhere else,
// so nothing in the document tree addresses them.
func (p *AIBlockProcessor) Children(blk *domain.SieveBlock) []*domain.SieveBlock {
	return append(blk.Elements(block.QuestionAttr), p.answerElements(*blk)...)
}

// answerElements is THE answer seam: the ordered blocks this exchange was
// answered with, or none when it has not been answered.
//
// Every consumer reads the answer here, so the degraded form is normalised once
// and nothing downstream carries a second arm: a producer that cannot compose
// blocks writes a bare string, and a bare string IS one prose block.
func (p *AIBlockProcessor) answerElements(blk domain.SieveBlock) []*domain.SieveBlock {
	raw, degraded := blk.Attrs[block.AnswerAttr].(string)
	if !degraded {
		return blk.Elements(block.AnswerAttr)
	}
	folded := p.proseElements(raw)
	out := make([]*domain.SieveBlock, len(folded))
	for i := range folded {
		out[i] = &folded[i]
	}
	return out
}

// foldAnswer reads whatever a producer returned into the element list an answer
// IS, so ingest accepts both the composed form and the raw one:
//
//   - a list of blocks passes through — it is already the answer;
//   - a string, or a list of strings, becomes one prose element apiece;
//   - a blank string is no answer at all and folds to nothing, because an answer
//     that is not there is never invented.
func (p *AIBlockProcessor) foldAnswer(result any) domain.Elements {
	switch v := result.(type) {
	case string:
		return p.proseElements(v)
	case []string:
		return p.proseElements(v...)
	default:
		return domain.DecodeElements(result)
	}
}

// proseElements mints one identified prose element per non-blank span.
func (p *AIBlockProcessor) proseElements(spans ...string) domain.Elements {
	out := make(domain.Elements, 0, len(spans))
	for _, s := range spans {
		if strings.TrimSpace(s) == "" {
			continue
		}
		out = append(out, domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": s}))
	}
	return out
}

// answerText renders the answer slot: the merged CONTENT of its elements,
// through the same per-kind AI seam the question body renders through — so an
// answer composed of any kind reads to a model the way that kind reads.
func (p *AIBlockProcessor) answerText(blk domain.SieveBlock, doc block.ContainerView) string {
	return strings.TrimSpace(block.MergeContexts(p.elementContexts(p.answerElements(blk), doc)).Content)
}

// aiBlockLabel is the in-flight status label for an ai-block job.
func (p *AIBlockProcessor) aiBlockLabel(blk *domain.SieveBlock) string {
	if t, _ := blk.Attrs["type"].(string); t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// qaHeader renders the QUESTION-side of this block's Q&A WITHOUT its own answer:
// "EXPLAIN NODE: <address>" or "QUESTION ABOUT: <address>\n<question>", followed by the
// "Specifically regarding" line of what its local targets quote (localFocus), then this
// turn's ATTACHED DOCUMENTS section when it has one. A question about nothing it
// can name is its text alone, with no QUESTION ABOUT line. It is the ACTION
// assembly — the block being asked must never carry its own prior answer, or a
// retry (where the doc snapshot already holds a stale answer) biases the new answer.
// BuildContext (THREAD / ref-chain / target callers) calls this then appends the
// answer, because the conversation history MUST keep prior answers.
//
// THIS IS THE ATTACHMENTS SEAM, and it is per-TURN: attachments belong to a
// question, and this is the one place a question is rendered, so every turn in a
// thread carries the documents it was given. The order falls out — QUESTION,
// then ATTACHED DOCUMENTS, then the answer BuildContext appends.
func (p *AIBlockProcessor) qaHeader(blk domain.SieveBlock, doc block.ContainerView) string {
	q := p.foldQuestion(blk, doc)
	t, _ := blk.Attrs["type"].(string)
	named := q.targets.shown(doc)

	var sb strings.Builder
	if t == "EXPLAIN" {
		sb.WriteString("EXPLAIN NODE: ")
		sb.WriteString(named.names())
	} else {
		text := strings.TrimSpace(p.questionText(q.body, doc))
		if names := named.names(); names != "" {
			sb.WriteString("QUESTION ABOUT: ")
			sb.WriteString(names)
			if text != "" {
				sb.WriteString("\n")
			}
		}
		sb.WriteString(text)
	}
	sb.WriteString(p.localFocus(named, doc))
	return q.attachments.AppendTo(sb.String())
}

// localFocus renders, as one block.FocusTag trailer, what t's LOCAL targets say
// the question is specifically about: the words a quote of a block in this
// container holds. A local target is rendered by its handle, as the block it
// names or, already in the thread, not at all, so its element's own focus reaches
// the prompt only here. A target elsewhere is rendered as its own element in the
// TARGET slot (buildTargets), which carries its focus there. "" when no local
// target states one.
func (p *AIBlockProcessor) localFocus(t questionTargets, doc block.ContainerView) string {
	var local []*domain.SieveBlock
	for _, el := range t.els {
		if _, ok := t.localToken(el); ok {
			local = append(local, el)
		}
	}
	var focus []block.Tag
	for _, tag := range block.MergeContexts(p.elementContexts(local, doc)).Tags {
		if tag.Label == block.FocusTag {
			focus = append(focus, tag)
		}
	}
	return block.AIContext{Tags: focus}.String()
}

// questionSlots is an ai-block's question list folded into the three parts
// prompt assembly renders it in: the targets it is ABOUT, the blocks it IS, and
// the documents it was HANDED.
type questionSlots struct {
	targets questionTargets
	// body is every non-reference element, in list order, whatever its kind.
	body []*domain.SieveBlock
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
	els []*domain.SieveBlock
}

// targets is THE target seam: which of blk's question elements name material it
// is ABOUT. The fold's target slot and the chain walk both read it, so the
// target predicate has exactly one home.
func (p *AIBlockProcessor) targets(blk domain.SieveBlock, doc block.ContainerView) questionTargets {
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
func (p *AIBlockProcessor) foldQuestion(blk domain.SieveBlock, doc block.ContainerView) questionSlots {
	q := questionSlots{targets: questionTargets{own: domain.NewContainerAddress(doc.Container())}}
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
func (t questionTargets) isTarget(el *domain.SieveBlock) bool {
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
func (t questionTargets) localToken(el *domain.SieveBlock) (string, bool) {
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
func (t questionTargets) address(el *domain.SieveBlock) string {
	uri := el.StringAttr("uri")
	if addr, err := domain.ParseAddress(uri); err == nil {
		return addr.String()
	}
	return uri
}

// names spells the slot the way the header does, comma-separated in list order:
// a local target by its absolute address in this container (the container's own
// address for the whole document, else sieve://{container}/{leaf}, the leaf being
// the handle the chain resolves it by), so it equals the ADDRESS header of the
// entry it points at; any other by the address it carries.
func (t questionTargets) names() string {
	out := make([]string, 0, len(t.els))
	for _, el := range t.els {
		if token, local := t.localToken(el); local {
			if token == block.WholeDocumentRef {
				out = append(out, t.own.String())
			} else {
				out = append(out, domain.NewLeafAddress(t.own.Container, token).String())
			}
		} else {
			out = append(out, el.StringAttr("uri"))
		}
	}
	return strings.Join(out, ",")
}

// shown returns the targets worth naming: those the TARGET slot has something
// to show for. A local target whose block renders as a context that says nothing
// (an empty paragraph) or that no longer exists is left out, by the same rule
// block.ContextSeries applies to its entries. A target elsewhere and the whole
// document are always kept, as is a local ai-block, which always has a question.
// Order is preserved.
func (t questionTargets) shown(doc block.ContainerView) questionTargets {
	out := questionTargets{own: t.own}
	for _, el := range t.els {
		token, local := t.localToken(el)
		if local && token != block.WholeDocumentRef &&
			!block.BuildContextForID(token, doc, map[string]bool{}, nil).Speaks() {
			continue
		}
		out.els = append(out.els, el)
	}
	return out
}

// elementContexts renders elements through the registered per-kind AI seam, in
// list order — the ONE way an element becomes prompt text, so a question or a
// target composed of any kind reads the way that kind reads to a model.
//
// THE ADDRESS HEADER IS DROPPED. A provider names the block it renders, and an
// element is not in the document tree: nothing resolves its address, so
// publishing one would hand the model a coordinate that names nothing. What a reference element IS reachable
// by — its address — the reference kind already renders as a trailer.
//
// doc is forwarded to each provider as the snapshot it renders against; an
// element is not in that tree, so a provider resolving ids finds nothing there.
func (p *AIBlockProcessor) elementContexts(els []*domain.SieveBlock, doc block.ContainerView) []block.AIContext {
	out := make([]block.AIContext, 0, len(els))
	for _, el := range els {
		cp := block.GetContextProvider(el.Kind)
		if cp == nil {
			logger.Warn("ai-block: no provider registered for element kind", "kind", el.Kind)
			continue
		}
		ctx := cp.BuildContext(*el, doc, map[string]bool{})
		ctx.Addresses = nil
		out = append(out, ctx.OfKind(el.Kind))
	}
	return out
}

// questionText renders the body slot: the merged CONTENT of its elements. A
// trailer is dropped with it — it belongs to the block it was extracted from,
// not to the question asking about that block.
func (p *AIBlockProcessor) questionText(body []*domain.SieveBlock, doc block.ContainerView) string {
	return block.MergeContexts(p.elementContexts(body, doc)).Content
}

// BuildContext returns a Q&A summary for when this block appears in another block's
// ref chain. The ADDRESS header is rendered by AIContext.String (from Addresses); the
// QUESTION ABOUT / EXPLAIN NODE line stays in Content because it is a header before
// the Q&A, not a mergeable trailer. Unlike the ACTION assembly (qaHeader) this DOES
// append the block's own answer — a ref-chain / THREAD entry is conversation history.
func (p *AIBlockProcessor) BuildContext(blk domain.SieveBlock, doc block.ContainerView, seen map[string]bool) block.AIContext {
	t, _ := blk.Attrs["type"].(string)

	sb := strings.Builder{}
	sb.WriteString(p.qaHeader(blk, doc))
	if answer := p.answerText(blk, doc); answer != "" {
		if t == "EXPLAIN" {
			sb.WriteString("\n**ANSWER:** ")
		} else {
			sb.WriteString("\n\n**ANSWER:** ")
		}
		sb.WriteString(answer)
	}

	return doc.NodeContext(blk.ID, sb.String())
}

// chainWalk is the target graph resolved: the terminal MANY the chain bottoms
// out at, split by WHERE each member lives, plus the interior nodes between the
// action block and it.
type chainWalk struct {
	// local are the handles of terminal nodes in this container — the
	// whole-document sentinel, or a block id.
	local []string
	// foreign are the terminal targets naming another container.
	foreign []*domain.SieveBlock
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
func (p *AIBlockProcessor) resolveChain(blk domain.SieveBlock, doc block.ContainerView) chainWalk {
	var w chainWalk
	seen := map[string]bool{}
	if blk.ID != "" {
		seen[domain.NewLeafAddress(doc.Container(), blk.ID).String()] = true
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
			child, ok := doc.Block(token)
			if !ok {
				w.local = append(w.local, token)
				continue
			}
			if next := p.targets(child, doc); len(next.els) == 0 {
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

// buildTargets renders the terminal MANY as a TARGET: each member is its own
// entry, in order, opened by a "===== BLOCK n of m · kind =====" line and headed
// by its ADDRESS (block.ContextSeries.Blocks), and the "Specifically regarding"
// trailers of all members union into ONE focus line after the last entry. Empty
// contexts drop out and are not counted; no members renders as "".
//
// The MANY has two kinds of member. A member in THIS document is resolved by
// handle (BuildContextForID) and its content is inlined; the whole document is
// the member of kind "document". A member elsewhere is a foreign element that
// resolves to nothing here, so it renders as the reference it is, carrying its own
// kind, with no ADDRESS line (nothing here resolves its address); the model
// dereferences it through the MCP verb if it needs the content.
func (p *AIBlockProcessor) buildTargets(w chainWalk, doc block.ContainerView) string {
	var ctxs block.ContextSeries
	// Exclude this processor's own kind: when a target is the whole doc, its derived
	// markdown must not carry prior ai-block answers — an ai-block serializes as its
	// raw YAML fence (question + answer), and including prior answers makes the
	// model fixate on its own stale output and resurrect document text quoted inside
	// old answers. THREAD (a separate slot) still carries the conversation. A
	// specific-block target ignores the filter (returned as-is).
	noSelfKind := func(b domain.SieveBlock) bool { return b.Kind != p.Kind() }
	for _, id := range w.local {
		ctxs = append(ctxs, block.BuildContextForID(id, doc, map[string]bool{}, noSelfKind))
	}
	ctxs = append(ctxs, p.elementContexts(w.foreign, doc)...)
	return ctxs.Blocks()
}

// exchangePrompt is an exchange's prompt assembled from the immutable job
// snapshot, in the three slots both the ask and the chat tasks show:
//
//   - target — the TARGET (a chat's ABOUT): the chain's leaves less anything in
//     the thread, rendered as numbered BLOCK entries (buildTargets).
//   - thread — the THREAD, oldest first: what the container orders before the
//     exchange as conversation, then the interior of its reference chain, each a
//     Q&A entry's context headed by its address.
//   - question — the ACTION (a chat's QUESTION): the exchange's own question-side
//     under its ADDRESS header. It must NOT carry its own prior answer: on a retry
//     the snapshot already holds a stale answer, and leaking it into the ACTION
//     biases the new one.
//
// conversation says whether the container declared itself a conversation, which
// makes the run the chat task.
type exchangePrompt struct {
	target       string
	thread       []block.AIContext
	question     string
	conversation bool
}

// chatData is the prompt as the chat task's data: each thread entry that says
// something is a turn under its address, oldest first.
func (e exchangePrompt) chatData() ai.ChatData {
	data := ai.ChatData{About: e.target, Question: e.question}
	for _, ctx := range e.thread {
		if !ctx.Speaks() {
			continue
		}
		address := strings.Join(ctx.Addresses, ",")
		ctx.Addresses = nil
		data.Turns = append(data.Turns, ai.ChatTurn{Address: address, Text: ctx.String()})
	}
	return data
}

// assemble builds blk's prompt, splitting its reference graph by GEOMETRY
// (resolveChain) and taking the conversation the view orders before blk
// (ContainerView.ConversationBefore). A container that orders no conversation
// leaves the thread the chain's interior alone.
func (p *AIBlockProcessor) assemble(blk *domain.SieveBlock, doc block.ContainerView) exchangePrompt {
	w := p.resolveChain(*blk, doc)
	earlier, conversation := doc.ConversationBefore(blk.ID)

	inThread := map[string]bool{}
	var threadIDs []string
	for _, id := range append(append([]string(nil), earlier...), w.thread...) {
		if !inThread[id] {
			inThread[id] = true
			threadIDs = append(threadIDs, id)
		}
	}
	var leaves []string
	for _, id := range w.local {
		if !inThread[id] {
			leaves = append(leaves, id)
		}
	}
	w.local = leaves

	e := exchangePrompt{target: p.buildTargets(w, doc), conversation: conversation}
	seen := map[string]bool{blk.ID: true}
	for _, id := range threadIDs {
		// THREAD resolution is untouched (nil filter): the conversation history must
		// keep prior answers verbatim.
		e.thread = append(e.thread, block.BuildContextForID(id, doc, seen, nil))
	}
	e.question = doc.NodeContext(blk.ID, p.qaHeader(*blk, doc)).String()
	return e
}

// buildPrompt is the ask and explain tasks' rendering of the assembled prompt:
// the TARGET, the THREAD as numbered "===== TURN n of m =====" entries, and the
// ACTION. Split out of DescribeJob so the assembled prompt is assertable without
// running a job or reaching a CLI.
func (p *AIBlockProcessor) buildPrompt(blk *domain.SieveBlock, doc block.ContainerView) (content, history, question string) {
	e := p.assemble(blk, doc)
	return e.target, block.ContextSeries(e.thread).Turns(), e.question
}

// DescribeJob builds the prompt (assemble) synchronously from the immutable
// jctx.Doc snapshot and captures it in Work: the chat task's run when the view
// declares a conversation, otherwise ask's or, for an EXPLAIN block, explain's.
// Apply writes the success attrs. An ai-block always has async work (born
// PENDING), so DescribeJob never returns nil. The error path (status
// ERROR/TIMEOUT) is the framework's job in EditorService.finish, so Apply is
// success-only.
func (p *AIBlockProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	blockType, _ := blk.Attrs["type"].(string)
	e := p.assemble(blk, jctx.Doc)
	ex := domain.Exchange{Container: jctx.UUID, Block: blk.ID}

	var work func() (any, error)
	if e.conversation {
		data := e.chatData()
		work = func() (any, error) { return p.svc.AI.RunChat(data, ex) }
	} else {
		history := block.ContextSeries(e.thread).Turns()
		work = func() (any, error) {
			if blockType == "EXPLAIN" {
				return p.svc.AI.RunExplain(e.target, history, e.question, ex)
			}
			return p.svc.AI.RunAsk(e.target, history, e.question, ex)
		}
	}
	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    p.aiBlockLabel(blk),
		Work:     work,
		Apply:    p.settle,
	}
}

// settle completes the exchange b with the run's result. An answer the model
// wrote into the exchange is already its answer slot, so the final message is
// discarded; otherwise the final message is folded into the answer.
func (p *AIBlockProcessor) settle(result any, b *domain.SieveBlock) {
	b.Attrs["status"] = block.BlockStatusComplete
	if answer, _ := result.(ai.Answer); !answer.Written {
		b.SetElements(block.AnswerAttr, p.foldAnswer(answer.Text))
	}
	b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
}

// MarkdownRepresentation renders an ANSWERED exchange as ordinary document
// markdown — the one form behind both "Embed in Document" (the prose processor's
// Transform asks for it) and the markdown export (DocView.markdownRepresentation asks
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
func (p *AIBlockProcessor) MarkdownRepresentation(blk domain.SieveBlock, uuid string) string {
	status, _ := blk.Attrs["status"].(string)
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: uuid}}
	answer := p.answerText(blk, doc)
	if status != block.BlockStatusComplete || answer == "" {
		return ""
	}
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
	return strings.Join(append(parts, answer), "\n\n")
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
func (p *AIBlockProcessor) embedHeading(body []*domain.SieveBlock) (string, []*domain.SieveBlock) {
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
	remainder := domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": rest})
	return head, append([]*domain.SieveBlock{&remainder}, body[1:]...)
}
