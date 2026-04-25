package sieve

import "fmt"

// FilingOutcome is the result of EvaluateAndFileDoc.
// Exactly one of Note or Buffer is non-nil when Discarded is false.
type FilingOutcome struct {
	Discarded bool
	Note      *Note
	Buffer    *Buffer
}

// EvaluateAndFileDoc runs the full evaluate-and-file pipeline for the document
// at path. It loads the document, optionally runs AI evaluation, applies the
// recommendation, and saves or promotes the document.
//
// Parameters:
//   - path:         store-relative path of the document (buffer or note)
//   - fileAfter:    when true, promote a buffer to the Library (or refile a note)
//   - allowDiscard: when true, empty bodies and trash-intent docs are deleted
func EvaluateAndFileDoc(
	path string,
	buffers *BufferService,
	notes *NoteService,
	settings Settings,
	folders []string,
	promptTmpl string,
	fileAfter bool,
	allowDiscard bool,
) (FilingOutcome, error) {
	b, n, isNote, err := filingLoadDoc(path, buffers, notes)
	if err != nil {
		return FilingOutcome{}, err
	}

	var meta DocumentMeta
	var body []byte
	if isNote {
		meta, body = n.Meta(), n.Body()
	} else {
		meta, body = b.Meta(), b.Body()
	}

	userIntent := ""
	if ui := meta.UserIntent(); ui != nil {
		userIntent = *ui
	}

	// Discard empty unfiled documents (body is blank and user hasn't kept it).
	if fileAfter && isHTMLBodyEmpty(string(body)) && userIntent != "keep" {
		return FilingOutcome{Discarded: true}, filingDiscardDoc(isNote, b, n, buffers, notes)
	}

	// Respect explicit trash intent: discard when allowed, otherwise save-only
	// (never run AI or file a document the user has explicitly marked for deletion).
	if userIntent == "trash" {
		if allowDiscard {
			return FilingOutcome{Discarded: true}, filingDiscardDoc(isNote, b, n, buffers, notes)
		}
		return filingCommitDoc(isNote, b, n, buffers, notes, false, false)
	}

	// Run AI evaluation and apply the filing recommendation.
	evaluated, err := filingApplyEval(meta, body, path, settings, folders, promptTmpl)
	if err != nil {
		return FilingOutcome{}, err
	}

	return filingCommitDoc(isNote, b, n, buffers, notes, evaluated, fileAfter)
}

func filingLoadDoc(path string, buffers *BufferService, notes *NoteService) (*Buffer, *Note, bool, error) {
	if b, err := buffers.Load(path); err == nil {
		return b, nil, false, nil
	}
	if n, err := notes.Load(path); err == nil {
		return nil, n, true, nil
	}
	return nil, nil, false, fmt.Errorf("filing: document not found: %s", path)
}

// filingApplyEval runs EvaluateBuffer and writes the recommendation into meta.
// Returns false (no-op) when running in dumb-tier (no AI configured).
func filingApplyEval(meta DocumentMeta, body []byte, path string, settings Settings, folders []string, promptTmpl string) (bool, error) {
	if settings.Tier() == TierDumb {
		return false, nil
	}
	rec, err := EvaluateBuffer(meta, body, folders, settings, promptTmpl)
	if err != nil {
		return false, fmt.Errorf("filing: eval %s: %w", path, err)
	}
	ApplyFilingRec(meta, rec, settings.CLI)
	return true, nil
}

func filingCommitDoc(isNote bool, b *Buffer, n *Note, buffers *BufferService, notes *NoteService, save bool, fileAfter bool) (FilingOutcome, error) {
	if isNote {
		return filingCommitNote(n, notes, save, fileAfter)
	}
	return filingCommitBuffer(b, buffers, save, fileAfter)
}

func filingCommitNote(n *Note, notes *NoteService, save bool, fileAfter bool) (FilingOutcome, error) {
	if save {
		saved, err := notes.Save(n)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: save note: %w", err)
		}
		n = saved
	}
	if fileAfter {
		refiled, err := notes.Refile(n)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: refile: %w", err)
		}
		return FilingOutcome{Note: refiled}, nil
	}
	return FilingOutcome{Note: n}, nil
}

func filingCommitBuffer(b *Buffer, buffers *BufferService, save bool, fileAfter bool) (FilingOutcome, error) {
	if save {
		saved, err := buffers.Save(b)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: save buffer: %w", err)
		}
		b = saved
	}
	if fileAfter {
		note, err := buffers.File(b)
		if err != nil {
			return FilingOutcome{}, fmt.Errorf("filing: file: %w", err)
		}
		return FilingOutcome{Note: note}, nil
	}
	return FilingOutcome{Buffer: b}, nil
}

func filingDiscardDoc(isNote bool, b *Buffer, n *Note, buffers *BufferService, notes *NoteService) error {
	if isNote {
		return notes.Delete(n)
	}
	return buffers.Discard(b)
}

// isHTMLBodyEmpty returns true if html contains no visible text content —
// only tags, whitespace, and self-closing elements. Used to detect blank
// buffers before discarding them without involving the AI.
func isHTMLBodyEmpty(html string) bool {
	inTag := false
	for _, r := range html {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag && r != ' ' && r != '\t' && r != '\n' && r != '\r':
			return false
		}
	}
	return true
}
