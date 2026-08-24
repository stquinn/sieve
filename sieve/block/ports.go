package block

import (
	"time"

	"sieve/sieve/domain"
	"sieve/store"
)

// Port interfaces are the contract block processors depend on. Concrete services
// implement them; the composition root wires them into BlockServices. This is the
// dependency inversion that lets the block layer own the contract it needs without
// importing any concrete service — the seam that breaks the service<->processor
// import cycle when the package is decomposed (tech-debt S-A). Signatures match the
// existing concrete service methods exactly, so this is behaviour-preserving.

// DocumentsPort is the document load/save surface processors use.
type DocumentsPort interface {
	LoadByUUID(uuid string) (domain.Document, error)
	Save(d domain.Document) (domain.Document, error)
}

// AssetsPort is the binary-asset surface processors use. It carries BOTH halves
// of an asset's life, not just the write: a kind that INGESTS a file has to read
// the bytes back to say anything about them (the attachment kind stamps size,
// mime and a text excerpt from them), and a write-only port would have forced
// that read onto the raw store — past the seam that keeps processors stubbable.
type AssetsPort interface {
	Save(category store.Category, parentContext, assetID string, data []byte) (*domain.ImageAsset, error)
	ServeAssetData(docUUID, filename string) ([]byte, error)
}

// NodesPort is the address-resolution surface processors use: one method,
// coordinate -> NodeDescriptor. editor.Router is the implementation and the composition
// root injects it.
//
// This port is not the same KIND of seam as its siblings. The others keep
// processors off concrete services and make them stubbable; this one is
// load-bearing structure, because block/ CANNOT import editor/ at all — editor
// imports block, so the reverse edge closes a cycle. The CONSUMER therefore
// declares the interface, exactly as mcp.NodeResolver does for the same
// resolver.
//
// The Router's REFUSALS are part of this contract and are the caller's to
// interpret — there is exactly one place that decides what a coordinate means:
//
//	domain.ErrBadAddress   the string is not a coordinate at all
//	domain.ErrNodeNotFound a well-formed address nothing holds (deleted, unfiled)
//
// ErrNodeNotFound is DANGLING, which is a normal state a block renders (a cached
// face with a missing marker), never a failure it reports.
type NodesPort interface {
	Resolve(uri string) (domain.NodeDescriptor, error)
}

// StatePort is the settings-read surface processors use.
type StatePort interface {
	LoadSettings() domain.Settings
	// ActiveThemeVars returns the resolved variables of the currently configured
	// theme (store-local override first, then embedded builtins). Processors that
	// theme their output (e.g. the diagram render job's PlantUML preamble) read it.
	ActiveThemeVars() domain.ThemeVars
}

// LinkPreviewPort is the URL-metadata surface processors use. FetchTitle's deadline
// is the caller's to set because its callers differ in kind: a background job can
// afford to wait for a slow site, a paste blocking in front of the caret cannot.
type LinkPreviewPort interface {
	FetchTitle(targetURL string, timeout time.Duration) string
	FetchFull(targetURL string) domain.LinkPreviewResult
}

// PlantumlPort is the PlantUML rendering surface processors use. Render takes
// PlantUML source and returns SVG bytes. v1 backend is an HTTP fetch from the
// configured server; a local-jar backend can replace it behind this seam.
type PlantumlPort interface {
	Render(source string) ([]byte, error)
}
