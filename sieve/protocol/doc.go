// Package protocol is the single source of truth for Sieve's wire contract: the
// frames of the two WebSocket channels (document and workspace) and the typed
// bodies of the JSON endpoints.
//
// Prose lives at the DECLARATION SITE, never in the Registry. Every frame and
// endpoint type carries a godoc comment — that comment is the documentation of
// record, rendered by `go doc sieve/sieve/protocol` and extracted verbatim by
// tools/protocolgen via go/doc — and every field whose meaning is not obvious
// from its name carries a doc:"…" tag beside its json:"…" tag. The Registry
// carries wire metadata only (channel, direction, type word, payload type,
// method, path, response kind), so there is exactly one place a contract can be
// described and it is next to the code that implements it.
//
// The Registry is the ANTI-DRIFT device: frame dispatch and emission go through
// it, so a frame type that is not registered cannot be spoken, and generation
// walks it by reflection rather than scraping handler source.
//
// Three rules bound the package:
//
//   - Position in the DAG — protocol sits above block/ and domain/ and imports
//     nothing else from the tree. requesthandlers and the root wire themselves to
//     it; nothing below it may import it. A payload type owned by block/ or
//     domain/ is REFERENCED, never re-declared here.
//   - What earns a FRAME rather than an endpoint — an operation belongs on the
//     document wire when it participates in an open editing session (it needs the
//     shadow, the listener claim, or a render-back), and on the workspace wire as
//     a command when it acts on the workspace's world by address, meaningful on a
//     closed document. HTTP keeps hypermedia and byte serving. That razor is why
//     the typed endpoint list is short, and why loading, pasting and exporting a
//     document are frames. Its one exception is a document that HAS no channel:
//     a prompt pseudo-document never opens one, so its load and its save stay on
//     HTTP as a pair — everything the razor moved to the wire, it moved for
//     documents that have a wire.
//   - What earns a Registry entry — every frame does; an endpoint does when its
//     contract is typed data in either direction (a request body or parameter
//     set, or a typed response). Endpoints with neither are hypermedia: their
//     contract is the template, and they appear in the route inventory that
//     chi.Walk produces, not here. That line is not arbitrary — an endpoint with
//     no request and no response type has nowhere for its prose to live, and this
//     package's whole discipline is that prose lives on a declaration.
//
// Changing anything here means regenerating what publishes it:
//
//	go generate ./sieve/protocol
package protocol

//go:generate go run sieve/tools/protocolgen
