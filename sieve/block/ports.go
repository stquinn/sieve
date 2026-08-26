package block

import (
	"time"

	"sieve/sieve/domain"
	"sieve/store"
)

// Port interfaces are the contract block processors depend on. Concrete services
// implement them; the composition root wires them into BlockServices, so no
// processor imports a concrete service.

// DocumentsPort is the document load/save surface processors use.
type DocumentsPort interface {
	LoadByUUID(uuid string) (domain.Document, error)
	Save(d domain.Document) (domain.Document, error)
}

// AssetsPort is the binary-asset surface processors use. It carries both halves
// of an asset's life: a kind that holds a file also has to read the bytes back to
// hand them on.
type AssetsPort interface {
	Save(category store.Category, parentContext, assetID string, data []byte) (*domain.ImageAsset, error)
	ServeAssetData(docUUID, filename string) ([]byte, error)
}

// NodesPort is the address-resolution surface processors use: one method,
// coordinate -> NodeDescriptor. editor.Router implements it and the composition
// root injects it.
//
// It takes a TYPED coordinate: a reference's uri arrives off disk as text, so the
// processor parses it at its own door, and a uri that is not a Sieve coordinate
// is a malformed reference the block reports rather than something the resolver
// is asked about.
//
// domain.ErrNodeNotFound — a well-formed address nothing holds — is DANGLING, a
// normal state a block renders as a cached face with a missing marker, never a
// failure it reports.
type NodesPort interface {
	Resolve(addr domain.Address) (domain.NodeDescriptor, error)
}

// StatePort is the settings-read surface processors use.
type StatePort interface {
	LoadSettings() domain.Settings
	// ActiveThemeVars returns the resolved variables of the currently configured
	// theme (store-local override first, then embedded builtins). Processors that
	// theme their output (e.g. the diagram render job's PlantUML preamble) read it.
	ActiveThemeVars() domain.ThemeVars
}

// LinkPreviewPort is the URL-metadata surface processors use. FetchTitle's
// deadline is the caller's to set: a background job can wait for a slow site, a
// paste blocking in front of the caret cannot.
type LinkPreviewPort interface {
	FetchTitle(targetURL string, timeout time.Duration) string
	FetchFull(targetURL string) domain.LinkPreviewResult
}

// PlantumlPort is the PlantUML rendering surface processors use: Render takes
// PlantUML source and returns SVG bytes.
type PlantumlPort interface {
	Render(source string) ([]byte, error)
}
