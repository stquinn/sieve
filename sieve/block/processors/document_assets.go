package processors

import (
	"fmt"
	"path/filepath"
	"strings"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// documentAssets writes a block's binary payload into the document that holds it.
// It is the ONE place that decides WHERE such bytes live: the category follows the
// document's own kind (a note's assets belong to the Library, a buffer's to the
// working copy), and the saved asset is attached to the document so the ownership
// graph knows about it.
//
// It exists as a type rather than as a method on each processor because two kinds
// ingest bytes — smart-image from a paste, attachment from a drop — and they must
// place them identically. A second copy of this rule would eventually put one
// kind's assets in the wrong category.
type documentAssets struct {
	svc block.BlockServices
	// kind names the owner in the log line, so a save can still be traced to the
	// block flavour that asked for it.
	kind string
}

// save persists data as an asset of document uuid under assetID, and returns the
// reference a block stores in its src attr.
//
// assetID is the caller's choice, and the store derives the on-disk filename from
// it: an id with no extension gets one sniffed from the magic bytes, an id that
// carries one keeps it. A caller that knows the true format (a dropped file's own
// name) therefore says so by passing the extension.
func (a documentAssets) save(uuid, assetID string, data []byte) (string, error) {
	if a.svc.Assets == nil {
		return "", fmt.Errorf("%s: no asset service wired", a.kind)
	}

	cat := domain.WorkingCopy
	var doc domain.Document
	if a.svc.Documents != nil {
		if d, err := a.svc.Documents.LoadByUUID(uuid); err == nil {
			doc = d
			if doc.Kind() == domain.KindNote {
				cat = domain.LibraryCategory
			}
		}
	}

	logger.Info(a.kind+": saving asset", "block", assetID, "uuid", uuid, "bytes", len(data))
	asset, err := a.svc.Assets.Save(cat, uuid, assetID, data)
	if err != nil {
		return "", err
	}

	if doc != nil {
		doc.Storable().AttachAsset(asset.Storable())
		if _, err := a.svc.Documents.Save(doc); err != nil {
			// Non-fatal: the asset is on disk and the block's src reaches it. Only
			// the ownership metadata is missing.
			logger.Warn(a.kind+": doc save after attach failed", "block", assetID, "err", err)
		}
	}

	return asset.ExternalRef(), nil
}

// filename recovers the bare asset name from a stored src. A src is always a
// filename in the document directory, so the `.assets/` strip and the basename
// are defensive against an older, path-qualified one.
func (a documentAssets) filename(src string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(src), ".assets/")
	if trimmed == "" {
		return ""
	}
	return filepath.Base(trimmed)
}

// url is the served route the document renders an asset through. Export markdown
// is read OUTSIDE Sieve, so a stored src has to leave as a working URL — and
// both kinds that hold bytes must spell that route the same way.
func (a documentAssets) url(uuid, src string) string {
	name := a.filename(src)
	if name == "" {
		return ""
	}
	return "/sieve/" + uuid + "/" + name
}
