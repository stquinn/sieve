package block

import (
	"strings"

	"sieve/logger"
	"sieve/sieve/domain"
)

// AIBlockMigrator converts an ai-block's legacy exchange — a question spread
// across three attrs and an answer held as one string — into the two ordered
// element lists `question` and `answer` now hold.
//
// The question's elements are minted in the order the legacy record rendered in:
//
//   - ref — comma-separated targets the question is about, each becoming a
//     reference element declaring RelTarget and addressed against this document.
//     A block id becomes a block-grain element; the "doc" sentinel names the
//     whole document rather than a block in it, so it becomes a CONTAINER-grain
//     element naming this document's own container. An EMPTY ref is the detached
//     class — a question about nothing — and mints no element at all, which is
//     what tells the two apart afterwards.
//   - question — the authored text, becoming a prose element.
//   - attachments — the per-turn manifest, each entry becoming a reference
//     element declaring RelAttach and carrying the attachment's address verbatim
//     and its title as the element's cached face.
//
// Both halves declare their role because the role is what a consumer classifies
// on: the two legacy attrs said which was which, and after conversion only `rel`
// does.
//
// The answer is one string, so it becomes one prose element — the degraded form
// every producer still writes, folded at the model's entrance rather than at
// each reader.
//
// It runs LAST in DocumentMigrator: the addresses it copies must already be in
// their current sieve:// spelling (ReferenceMigrator) and the ids it turns into
// leaf addresses must already be uuids (BlockIdentityMigrator).
//
// Conversion CONSUMES what it reads — `question` is replaced by the list, `ref`
// and `attachments` are deleted, and `response` goes once the answer list holds
// what it said. `ref` survives system-wide as the generic edge; only the
// ai-block stops using it.
//
// A slot showing BOTH forms (a list beside the legacy attrs it would be built
// from) is left exactly as stored: the two cannot be reconciled without guessing
// which one the author meant. So is a slot showing NEITHER — a question or an
// answer that is not there is never invented.
type AIBlockMigrator struct{}

// Migrate returns the tree with every ai-block's legacy exchange folded into its
// element lists, plus whether anything changed. The input is never mutated.
func (m AIBlockMigrator) Migrate(blocks []SieveBlock, documentUUID string) ([]SieveBlock, bool) {
	if len(blocks) == 0 {
		return blocks, false
	}
	changed := false
	out := make([]SieveBlock, len(blocks))
	for i, b := range blocks {
		if b.Kind == "ai-block" {
			if rewritten, dirty := m.migrateAttrs(b.Attrs, documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		}
		out[i] = b
	}
	return out, changed
}

// migrateAttrs folds one ai-block's legacy record into its element lists,
// cloning only when there is something to convert, so a current-form tree
// allocates nothing.
//
// The two slots convert INDEPENDENTLY: a record may have been half-converted by
// an earlier load, and a question already in its current form says nothing about
// what shape the answer is in.
func (m AIBlockMigrator) migrateAttrs(attrs map[string]interface{}, documentUUID string) (map[string]interface{}, bool) {
	question := m.convertedQuestion(attrs, documentUUID)
	answer := m.convertedAnswer(attrs)
	if len(question) == 0 && len(answer) == 0 {
		return attrs, false
	}

	cloned := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		cloned[k] = v
	}
	if len(question) > 0 {
		delete(cloned, "ref")
		delete(cloned, domain.AttachmentsAttr)
		cloned[QuestionAttr] = question
	}
	if len(answer) > 0 {
		delete(cloned, legacyResponseAttr)
		cloned[AnswerAttr] = answer
	}
	return cloned, true
}

// legacyResponseAttr is the attrs-bag key an answer was one string under, before
// it became a list of blocks. Nothing writes it and only conversion reads it.
const legacyResponseAttr = "response"

// convertedQuestion is the element list the legacy question record describes, or
// nil when there is nothing to convert.
func (m AIBlockMigrator) convertedQuestion(attrs map[string]interface{}, documentUUID string) Elements {
	converted := m.legacyElements(attrs, documentUUID)
	if stored := DecodeElements(attrs[QuestionAttr]); len(stored) > 0 {
		if len(converted) > 0 {
			logger.Warn("migrate: ai-block carries both question forms; leaving it as stored",
				"id", attrs["id"], "elements", len(stored))
		}
		return nil
	}
	return converted
}

// convertedAnswer is the one prose element the legacy `response` string
// describes, or nil when there is nothing to convert. A blank response is not an
// answer, so it converts to nothing and stays where it is.
func (m AIBlockMigrator) convertedAnswer(attrs map[string]interface{}) Elements {
	response, _ := attrs[legacyResponseAttr].(string)
	if stored := DecodeElements(attrs[AnswerAttr]); len(stored) > 0 {
		if strings.TrimSpace(response) != "" {
			logger.Warn("migrate: ai-block carries both answer forms; leaving it as stored",
				"id", attrs["id"], "elements", len(stored))
		}
		return nil
	}
	if strings.TrimSpace(response) == "" {
		return nil
	}
	// The string is carried VERBATIM: only its blankness was measured, and an
	// answer's leading whitespace can be markdown a trim would change.
	return Elements{NewSieveBlock(KindProse, "", map[string]interface{}{"content": response})}
}

// legacyElements builds the element list the legacy record describes, or nil
// when it describes no question at all.
func (m AIBlockMigrator) legacyElements(attrs map[string]interface{}, documentUUID string) Elements {
	var out Elements

	ref, _ := attrs["ref"].(string)
	for _, raw := range strings.Split(ref, ",") {
		target := strings.TrimSpace(raw)
		switch target {
		case "":
			continue
		case WholeDocumentRef:
			out = append(out, m.reference(domain.NewContainerAddress(documentUUID).String(), RelTarget, ""))
		default:
			out = append(out, m.reference(domain.NewLeafAddress(documentUUID, target).String(), RelTarget, ""))
		}
	}

	if question, _ := attrs[QuestionAttr].(string); strings.TrimSpace(question) != "" {
		out = append(out, NewSieveBlock(KindProse, "", map[string]interface{}{"content": question}))
	}

	for _, a := range domain.DecodeAttachments(attrs[domain.AttachmentsAttr]) {
		out = append(out, m.reference(a.URI, RelAttach, a.Title))
	}
	return out
}

// reference mints one reference element. It carries the address and nothing
// else: title, when the legacy record had one, is the FACE — what was taken from
// the target — and so goes under `cache`, never at the root, which means the
// pointing.
func (m AIBlockMigrator) reference(uri, rel, title string) SieveBlock {
	attrs := map[string]interface{}{"uri": uri, "rel": rel}
	if title != "" {
		attrs[FaceAttr] = map[string]interface{}{"title": title}
	}
	return NewSieveBlock(KindReference, "", attrs)
}
