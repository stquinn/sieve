package mcp

import "sieve/logger"

// bodyRead is one whole-content read of a Sieve document, as the audit trail
// records it.
//
// It is a TYPE, not two logger.Info calls, because it is the EVIDENCE behind the
// package's central claim: content leaves the knowledge base through get_note
// and get_by_uri and nowhere else. Two verbs are two doors; one record shape
// keeps them a single boundary, and keeps the two lines from drifting into
// describing the same read differently.
//
// Both namings of the target are carried. They are the same document — a uuid is
// what get_note is asked for, a coordinate is what get_by_uri is asked for — and
// recording both means one audit line answers either question.
type bodyRead struct {
	verb  string // the tool that performed the read
	uuid  string // the target's identity
	uri   string // the target's coordinate
	title string
	bytes int
}

// message is the log line, carrying the "(body read)" marker that makes the
// whole set greppable.
func (b bodyRead) message() string { return "sieve mcp: " + b.verb + " (body read)" }

// attrs is the structured half: what was read, and how much of it.
func (b bodyRead) attrs() []any {
	return []any{"uuid", b.uuid, "uri", b.uri, "title", b.title, "bytes", b.bytes}
}

// bodyReadAuditor is where those records go. Production writes them to the log;
// the package's own tests substitute a recorder, because "every body read is
// visible at one boundary" is an invariant worth asserting rather than assuming.
type bodyReadAuditor interface {
	record(b bodyRead)
}

// logAuditor is the production sink: one Info line per body read.
type logAuditor struct{}

func (logAuditor) record(b bodyRead) { logger.Info(b.message(), b.attrs()...) }
