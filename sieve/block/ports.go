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

// NodesPort is the address surface processors use: the Router (services.Router),
// a registry federating one source per container kind. Resolve turns an address
// into the Node it points at; Search enumerates what is addressable at all. Two
// faces of ONE registry, which is what enforces the invariant that a source may
// only offer candidates that can actually be dereferenced.
//
// NOT folded into DocumentsPort: the Router is not the document store. Documents
// are merely what the v1 notes source happens to sit on, and chats or Things
// register beside it without any consumer changing. Absorbing this into
// DocumentsPort would make DocumentService the federator and pin the block layer
// to documents — exactly what the registry exists to avoid.
//
// A dangling address (deleted target, never-addressable buffer) is
// domain.ErrNodeNotFound, not a panic: callers render the cached title instead.
type NodesPort interface {
	Resolve(uri string) (domain.Node, error)
	Search(query string, limit int) []domain.Candidate
}

// AssetsPort is the binary-asset persistence surface processors use.
type AssetsPort interface {
	Save(category store.Category, parentContext, assetID string, data []byte) (*domain.ImageAsset, error)
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
