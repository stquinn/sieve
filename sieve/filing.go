package sieve

import "fmt"

// FilingOutcome is the result of AIService.EvaluateAndFileDoc.
// Exactly one of Note or Buffer is non-nil when Discarded is false.
type FilingOutcome struct {
	Discarded bool
	Note      *Note
	Buffer    *Buffer
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
