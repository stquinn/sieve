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
	if read.container != uuid {
		t.Errorf("container = %q, want the document uuid", read.container)
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

// A leaf coordinate is dereferenced by the SAME verb a container one is — no new
// tool, no new input shape. That is what the address grammar bought: a model
// handed sieve://{container}/{block} reads that block and nothing else.
func TestGetByURI_DereferencesABlockAddress(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	const blockUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01"
	uuid := seedNote(t, ds, "Auth Design", "design", "auth-design", nil, "how tokens rotate",
		"Tokens rotate hourly.\n\n<!--s:"+blockUUID+"-->\nRefresh needs the rotation window.\n<!--/s:"+blockUUID+"-->\n")

	uri := domain.NewLeafAddress(uuid, blockUUID).String()
	_, node, err := s.getByURI(context.Background(), nil, URIInput{URI: uri})
	if err != nil {
		t.Fatalf("get_by_uri: %v", err)
	}
	if node.URI != uri || node.UUID != blockUUID {
		t.Errorf("node names the wrong target: uri=%q uuid=%q", node.URI, node.UUID)
	}
	if !strings.Contains(node.Body, "Refresh needs the rotation window.") {
		t.Errorf("body = %q, want the block's markdown", node.Body)
	}
	if strings.Contains(node.Body, "Tokens rotate hourly") {
		t.Errorf("body = %q, want ONLY the block the address named", node.Body)
	}
}

// A leaf read is still greppable BY DOCUMENT. The audit's uuid names what was
// actually read — a block id, or an asset filename — so the container is recorded
// beside it, or the document a leaf read came out of survives nowhere but inside
// the uri string.
func TestGetByURI_AuditNamesTheContainerOfALeafRead(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	rec := auditing(s)
	const blockUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02"
	uuid := seedNote(t, ds, "Auth Design", "design", "auth-design", nil, "",
		"<!--s:"+blockUUID+"-->\nRefresh needs the rotation window.\n<!--/s:"+blockUUID+"-->\n")

	if _, _, err := s.getByURI(context.Background(), nil,
		URIInput{URI: domain.NewLeafAddress(uuid, blockUUID).String()}); err != nil {
		t.Fatalf("get_by_uri: %v", err)
	}
	read := rec.reads[0]
	if read.container != uuid {
		t.Errorf("container = %q, want the document the block came out of", read.container)
	}
	if read.uuid != blockUUID {
		t.Errorf("uuid = %q, want the identity of what was actually read", read.uuid)
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
		{"unknown scheme", "thing://" + live, domain.ErrBadAddress},
		{"a web address", "https://example.com/secrets", domain.ErrBadAddress},
		{"leaf naming nothing in its container", uriOf(live) + "/intro", domain.ErrNodeNotFound},
		{"pin to a version nobody wrote", uriOf(live) + "?version=99", domain.ErrNodeNotFound},
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

// CONTAINMENT, structural rather than checked: get_by_uri parses its input into a
// domain.Address at its own door, and a domain.Address can only spell a sieve://
// coordinate. Every phrasing a model might reach for is refused the same way, and
// none reaches the resolver at all.
func TestGetByURI_CannotBeUsedToFetchTheWeb(t *testing.T) {
	s, _ := newTestServerWithDocs(t)
	counting := &countingResolver{}
	s.nodes = counting

	for _, uri := range []string{
		"https://example.com/secrets",
		"http://169.254.169.254/latest/meta-data/",
		"file:///etc/passwd",
		"HTTPS://EXAMPLE.COM",
		"  https://example.com  ",
	} {
		t.Run(uri, func(t *testing.T) {
			_, node, err := s.getByURI(context.Background(), nil, URIInput{URI: uri})
			if err == nil {
				t.Fatalf("%q was fetched: %+v", uri, node)
			}
			if !errors.Is(err, domain.ErrBadAddress) {
				t.Errorf("err = %v, want it to wrap ErrBadAddress", err)
			}
			// The refusal must say what a coordinate looks like: the reader is a
			// model, and "malformed address" alone teaches it nothing.
			if !strings.Contains(err.Error(), "not a Sieve coordinate") {
				t.Errorf("the refusal must be useful to a model: %v", err)
			}
		})
	}
	if counting.calls != 0 {
		t.Errorf("the resolver was asked %d times; a non-coordinate must stop at the door", counting.calls)
	}
}

// countingResolver answers nothing and counts being asked.
type countingResolver struct{ calls int }

func (c *countingResolver) Resolve(domain.Address) (domain.NodeDescriptor, error) {
	c.calls++
	return domain.NodeDescriptor{}, domain.ErrNodeNotFound
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
