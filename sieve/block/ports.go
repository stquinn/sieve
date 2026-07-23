package block

import (
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

// LinkPreviewPort is the URL-metadata surface processors use.
type LinkPreviewPort interface {
	FetchTitle(targetURL string) string
	FetchFull(targetURL string) domain.LinkPreviewResult
}

// PlantumlPort is the PlantUML rendering surface processors use. Render takes
// PlantUML source and returns SVG bytes. v1 backend is an HTTP fetch from the
// configured server; a local-jar backend can replace it behind this seam.
type PlantumlPort interface {
	Render(source string) ([]byte, error)
}
