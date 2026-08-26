package mcp

import "sieve/logger"

// bodyRead is one content read through a Sieve MCP verb, as the audit trail
// records it. Content leaves the knowledge base through get_note and get_by_uri
// and nowhere else, and both write one of these.
//
// A read is not always a whole document — get_by_uri dereferences a leaf
// coordinate too — so container and uuid are separate namings, which is what
// keeps the trail greppable by document.
type bodyRead struct {
	verb string // the tool that performed the read
	// container is the document the content came out of. Always a uuid, whatever
	// grain was read.
	container string
	// uuid is the identity of what was ACTUALLY read: the document itself for a
	// whole-content read, or a block id / asset key for a leaf one.
	uuid  string
	uri   string // the coordinate the target was named by
	title string
	bytes int
}

// message is the log line, carrying the "(body read)" marker that makes the
// whole set greppable.
func (b bodyRead) message() string { return "sieve mcp: " + b.verb + " (body read)" }

// attrs is the structured half: what was read, and how much of it.
func (b bodyRead) attrs() []any {
	return []any{"container", b.container, "uuid", b.uuid, "uri", b.uri, "title", b.title, "bytes", b.bytes}
}

// bodyReadAuditor is where those records go. Production writes them to the log;
// tests substitute a recorder.
type bodyReadAuditor interface {
	record(b bodyRead)
}

// logAuditor is the production sink: one Info line per body read.
type logAuditor struct{}

func (logAuditor) record(b bodyRead) { logger.Info(b.message(), b.attrs()...) }
