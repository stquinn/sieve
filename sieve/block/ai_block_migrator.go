package block

import (
	"strings"

	"sieve/logger"
	"sieve/sieve/domain"
)

// AIBlockMigrator converts an ai-block's legacy question record — three separate
// attrs — into the single ordered element list `question` now holds. The
// elements are minted in the order the legacy record rendered in:
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
// It runs LAST in DocumentMigrator: the addresses it copies must already be in
// their current sieve:// spelling (ReferenceMigrator) and the ids it turns into
// leaf addresses must already be uuids (BlockIdentityMigrator).
//
// Conversion CONSUMES what it reads — `question` is replaced by the list, `ref`
// and `attachments` are deleted. `ref` survives system-wide as the generic edge;
// only the ai-block stops using it.
//
// A record showing BOTH forms (a question list beside a legacy ref or attachment
// list) is left exactly as stored: the two cannot be reconciled without guessing
// which one the author meant. So is a record showing NEITHER — a question that
// is not there is never invented.
type AIBlockMigrator struct{}

// Migrate returns the tree with every ai-block's legacy question record folded
// into its element list, plus whether anything changed. The input is never
// mutated.
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

// migrateAttrs folds one ai-block's legacy record into its element list,
// cloning only when there is something to convert, so a current-form tree
// allocates nothing.
func (m AIBlockMigrator) migrateAttrs(attrs map[string]interface{}, documentUUID string) (map[string]interface{}, bool) {
	converted := m.legacyElements(attrs, documentUUID)
	if stored := DecodeElements(attrs[QuestionAttr]); len(stored) > 0 {
		if len(converted) > 0 {
			logger.Warn("migrate: ai-block carries both question forms; leaving it as stored",
				"id", attrs["id"], "elements", len(stored))
		}
		return attrs, false
	}
	if len(converted) == 0 {
		return attrs, false
	}

	cloned := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		cloned[k] = v
	}
	delete(cloned, "ref")
	delete(cloned, domain.AttachmentsAttr)
	cloned[QuestionAttr] = converted
	return cloned, true
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
