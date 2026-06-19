package sieve

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
}

// LinkPreviewPort is the URL-metadata surface processors use.
type LinkPreviewPort interface {
	FetchTitle(targetURL string) string
	FetchFull(targetURL string) domain.LinkPreviewResult
}

// AIPort is the AI surface processors use. ImageDesc is a return type here, so it
// is a shared data type (moves to domain/ during decomposition, not ai/).
type AIPort interface {
	RunExplain(content, history, question, noteUUID string) (string, error)
	RunAsk(content, history, question, noteUUID string) (string, error)
	RefineLanguage(content, currentLanguage, detectionMethod string) (string, error)
	DescribeImage(uuid, storeRelPath, blkId string) (domain.ImageDesc, error)
	RunWebClip(uuid, id, source, mode, docContent string) (title, content string, err error)
}

// Compile-time proof the concrete services satisfy the ports.
var (
	_ DocumentsPort   = (*DocumentService)(nil)
	_ AssetsPort      = (*AssetService)(nil)
	_ StatePort       = (*StateService)(nil)
	_ LinkPreviewPort = (*LinkPreviewService)(nil)
	_ AIPort          = (*AIService)(nil)
)
