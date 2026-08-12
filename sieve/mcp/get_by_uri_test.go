package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/editor"
)

// recordingAuditor stands in for the log so the body-read audit — the evidence
// behind "bulk-read is visible at a single Sieve-owned boundary" — is asserted
// rather than assumed.
type recordingAuditor struct{ reads []bodyRead }

func (r *recordingAuditor) record(b bodyRead) { r.reads = append(r.reads, b) }

// auditing swaps the server's auditor for a recorder and hands both back.
func auditing(s *Server) *recordingAuditor {
	rec := &recordingAuditor{}
	s.audit = rec
	return rec
}

// uriOf is the coordinate of a seeded note, spelled the one way the grammar
// spells it — the same string an attachment persists and a manifest emits.
func uriOf(uuid string) string { return domain.NewContainerAddress(uuid).String() }

// get_by_uri is the Router exposed as a tool: it takes the coordinate exactly as
// persisted and returns what that address names, body included.
func TestGetByURI_ResolvesAContainerAddressAndReturnsItsContent(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	uuid := seedNote(t, ds, "Auth Design", "design", "auth-design",
		[]string{"auth"}, "how tokens rotate", "# Auth Design\n\nTokens rotate hourly.")

	_, node, err := s.getByURI(context.Background(), nil, URIInput{URI: uriOf(uuid)})
	if err != nil {
		t.Fatalf("get_by_uri: %v", err)
	}
	if node.Title != "Auth Design" {
		t.Errorf("title = %q", node.Title)
	}
	if node.URI != uriOf(uuid) || node.UUID != uuid {
		t.Errorf("node names the wrong target: uri=%q uuid=%q", node.URI, node.UUID)
	}
	if node.Kind != string(domain.KindNote) {
		t.Errorf("kind = %q, want the source's own noun", node.Kind)
	}
	if !strings.Contains(node.Body, "Tokens rotate hourly") {
		t.Errorf("body = %q, want the markdown body", node.Body)
	}
}

// A body left Sieve, so the audit line that makes that visible must exist —
// naming the verb, the target and how much was read.
func TestGetByURI_LogsTheBodyReadAudit(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	rec := auditing(s)
	uuid := seedNote(t, ds, "Auth Design", "design", "auth-design", nil, "", "# Auth Design\n\nbody")

	if _, _, err := s.getByURI(context.Background(), nil, URIInput{URI: uriOf(uuid)}); err != nil {
		t.Fatalf("get_by_uri: %v", err)
	}
	if len(rec.reads) != 1 {
		t.Fatalf("body reads recorded = %d, want exactly 1: %+v", len(rec.reads), rec.reads)
	}
	read := rec.reads[0]
	if read.verb != "get_by_uri" || read.title != "Auth Design" || read.uri != uriOf(uuid) || read.uuid != uuid {
		t.Fatalf("audit record = %+v", read)
	}
	if read.bytes == 0 {
		t.Errorf("the audit must carry the byte count: %+v", read)
	}
	if !strings.Contains(read.message(), "(body read)") || !strings.Contains(read.message(), "get_by_uri") {
		t.Errorf("audit message = %q", read.message())
	}
}

// BOTH body-bearing verbs record the same audit shape. There are two doors out
// of the knowledge base now; they must both be visible in the same way, or the
// containment story stops being checkable by looking for one line.
func TestBodyRead_BothBodyBearingVerbsAuditIdentically(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	rec := auditing(s)
	uuid := seedNote(t, ds, "Auth Design", "design", "auth-design", nil, "", "# Auth Design\n\nbody")

	if _, _, err := s.getNote(context.Background(), nil, UUIDInput{UUID: uuid}); err != nil {
		t.Fatalf("get_note: %v", err)
	}
	if _, _, err := s.getByURI(context.Background(), nil, URIInput{URI: uriOf(uuid)}); err != nil {
		t.Fatalf("get_by_uri: %v", err)
	}
	if len(rec.reads) != 2 {
		t.Fatalf("body reads recorded = %d, want one per verb: %+v", len(rec.reads), rec.reads)
	}
	byNote, byURI := rec.reads[0], rec.reads[1]
	if byNote.verb != "get_note" || byURI.verb != "get_by_uri" {
		t.Fatalf("verbs = %q, %q", byNote.verb, byURI.verb)
	}
	// Same target, same evidence: only the verb differs.
	byNote.verb, byURI.verb = "", ""
	if byNote != byURI {
		t.Fatalf("the two body-read audits disagree about the same read:\n%+v\n%+v", byNote, byURI)
	}
}

// The Router's refusals ARE the tool's refusals — surfaced, never re-checked.
// Each is a clear error and no content, and none of them is a body read.
func TestGetByURI_SurfacesTheRoutersRefusals(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	live := seedNote(t, ds, "Auth Design", "design", "auth-design", nil, "", "body")
	doomed := seedNote(t, ds, "Doomed", "", "doomed", nil, "", "gone soon")
	doc, err := ds.LoadByUUID(doomed)
	if err != nil {
		t.Fatalf("load doomed: %v", err)
	}
	if err := ds.Delete(doc); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	cases := []struct {
		name string
		uri  string
		is   error
	}{
		{"malformed", "not-an-address", domain.ErrBadAddress},
		{"unknown scheme", "thing:" + live, domain.ErrBadAddress},
		{"scheme no source answers", "block:" + live, editor.ErrSchemeUnsupported},
		{"version pin", uriOf(live) + "@v2", editor.ErrVersionPinUnsupported},
		{"deleted target", uriOf(doomed), domain.ErrNodeNotFound},
		{"never existed", uriOf("11111111-2222-4333-8444-555555555555"), domain.ErrNodeNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := auditing(s)
			_, node, err := s.getByURI(context.Background(), nil, URIInput{URI: tc.uri})
			if err == nil {
				t.Fatalf("%q resolved to %+v; a refusal must be an error, never an empty success", tc.uri, node)
			}
			if !errors.Is(err, tc.is) {
				t.Errorf("err = %v, want it to wrap %v", err, tc.is)
			}
			if !strings.Contains(err.Error(), "get_by_uri") {
				t.Errorf("the tool error must name the verb: %v", err)
			}
			if node.Body != "" {
				t.Errorf("a refusal returned content: %+v", node)
			}
			if len(rec.reads) != 0 {
				t.Errorf("a refusal was audited as a body read: %+v", rec.reads)
			}
		})
	}
}

// An unwired resolver is a wiring bug, not a crash inside the MCP handler.
func TestGetByURI_WithoutAResolverErrsRatherThanPanicking(t *testing.T) {
	s, _ := newTestServerWithDocs(t)
	s.nodes = nil

	if _, _, err := s.getByURI(context.Background(), nil, URIInput{URI: uriOf("11111111-2222-4333-8444-555555555555")}); err == nil {
		t.Fatal("a server with no resolver answered get_by_uri")
	}
}

// Compile-time proof the Router satisfies the resolver this package declares.
// The composition root wires the concrete one; this pins the shape so a Router
// signature change cannot silently unwire the verb.
var _ NodeResolver = (*editor.Router)(nil)
