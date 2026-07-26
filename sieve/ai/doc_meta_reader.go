package ai

import "sieve/sieve/services"

// docMetaReader reads a document's title+summary from its persisted meta,
// tolerating every missing part. It owns the document service the read goes
// through and is embedded by the AI commands that enrich prompts with document
// context (btw/summary/todo), so the read lives in exactly one place.
//
// LoadByUUID resolves buffers too; accepted staleness = the autosave debounce.
type docMetaReader struct {
	docs *services.DocumentService
}

func (r docMetaReader) docMeta(uuid string) (title, summary string) {
	if uuid == "" || r.docs == nil {
		return "", ""
	}
	doc, err := r.docs.LoadByUUID(uuid)
	if err != nil {
		return "", ""
	}
	m := doc.Meta()
	title = m.DisplayName()
	if s := m.Summary(); s != nil {
		summary = *s
	}
	return title, summary
}
