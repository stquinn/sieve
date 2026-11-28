package services

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"sieve/sieve/domain"
	"sieve/store"
)

// AssetService manages binary assets (images, voice notes) through the Store
// interface. Create one with NewAssetService — do not construct directly.
//
// ImageAsset is a first-class Storable — it exists independently of any
// document. Ownership (which document contains it) is a graph relationship
// derived from the filesystem layout by FileStore. It is not a precondition
// for the asset to exist or be valid.
type AssetService struct {
	st       store.Store
	rootPath string
}

// NewAssetService creates an AssetService backed by st. rootPath is the library
// root; it bounds ServeStoreFile. An empty rootPath disables that method — the
// service is otherwise fully usable.
func NewAssetService(st store.Store, rootPath string) *AssetService {
	return &AssetService{st: st, rootPath: rootPath}
}

// ServeAssetData returns the raw bytes of the asset filename owned by ownerUUID,
// wherever its owner lives. Bypasses the owner's own service so concurrent asset
// requests for the same UUID do not race on shared in-memory state.
//
// On a miss it reloads the owner, which re-scans its directory, before retrying:
// an asset can be written after the owner was last read.
func (as *AssetService) ServeAssetData(ownerUUID, filename string) ([]byte, error) {
	owner, err := as.st.LoadByUUID(ownerUUID)
	if err != nil {
		return nil, fmt.Errorf("asset not found: %s/%s: %w", ownerUUID, filename, err)
	}
	if a, err := as.st.LoadAsset(owner.Category(), ownerUUID, filename); err == nil {
		return a.Body(), nil
	}
	if _, err := as.st.Load(owner.Category(), ownerUUID); err == nil {
		if a, err := as.st.LoadAsset(owner.Category(), ownerUUID, filename); err == nil {
			return a.Body(), nil
		}
	}
	return nil, fmt.Errorf("asset not found: %s/%s", ownerUUID, filename)
}

// Delete removes the asset filename of the container ownerUUID, wherever the
// store holds it, irreversibly. Whether any block still holds it is the caller's
// question; this removes the file it is told to.
func (as *AssetService) Delete(ownerUUID, filename string) error {
	owner, err := as.owner(ownerUUID)
	if err != nil {
		return fmt.Errorf("asset: delete %s from %s: %w", filename, ownerUUID, err)
	}
	if err := as.st.DeleteAsset(owner.Category(), ownerUUID, filename); err != nil {
		return fmt.Errorf("asset: delete %s from %s: %w", filename, ownerUUID, err)
	}
	return nil
}

// Save keeps data as the asset assetKey of the container ownerUUID, wherever the
// store holds it, and returns the resulting ImageAsset. The asset is attached to
// the owner's ownership list without moving the owner's version, and replaces any
// asset of the same key. The Encoding is inferred from magic bytes by the Store.
//
// The returned ImageAsset.ExternalRef() is the opaque reference suitable for
// direct insertion into editor markdown.
func (as *AssetService) Save(ownerUUID, assetKey string, data []byte) (*domain.ImageAsset, error) {
	owner, err := as.owner(ownerUUID)
	if err != nil {
		return nil, fmt.Errorf("asset: save %s for %s: %w", assetKey, ownerUUID, err)
	}
	s, err := store.OwnedAssets{Store: as.st}.Save(owner, assetKey, data)
	if err != nil {
		return nil, fmt.Errorf("asset: save %s for %s: %w", assetKey, ownerUUID, err)
	}
	return &domain.ImageAsset{S: s}, nil
}

// OwnedKeys returns the key of every asset the container ownerUUID holds, as
// the store last recorded them.
func (as *AssetService) OwnedKeys(ownerUUID string) ([]string, error) {
	owner, err := as.owner(ownerUUID)
	if err != nil {
		return nil, fmt.Errorf("asset: list assets of %s: %w", ownerUUID, err)
	}
	var keys []string
	for _, a := range owner.Owns() {
		keys = append(keys, a.Key())
	}
	return keys, nil
}

// owner finds the container uuid in the store, whatever category holds it.
func (as *AssetService) owner(uuid string) (store.MetaStorable, error) {
	s, err := as.st.LoadByUUID(uuid)
	if err != nil {
		return nil, err
	}
	ms, ok := s.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("%s is not a container that keeps assets", uuid)
	}
	return ms, nil
}

// PageAssetKey returns the deterministic HTML asset filename for rawURL,
// page-{slug}-{hash}.html.
// Two calls for the same URL address the same asset key within a container.
func (as *AssetService) PageAssetKey(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	sum := sha256.Sum256([]byte(trimmed))
	shortHash := hex.EncodeToString(sum[:6])
	slug := as.urlSlug(trimmed)
	if slug == "" {
		return "page-" + shortHash + ".html"
	}
	return "page-" + slug + "-" + shortHash + ".html"
}

// PageAssetAddress returns the absolute sieve://{owner}/{key} address of the
// page asset for rawURL when the container ownerUUID owns that asset, or the
// empty string when it does not (or ownerUUID names nothing).
func (as *AssetService) PageAssetAddress(ownerUUID, rawURL string) string {
	if strings.TrimSpace(ownerUUID) == "" || strings.TrimSpace(rawURL) == "" {
		return ""
	}
	keys, err := as.OwnedKeys(ownerUUID)
	if err != nil {
		return ""
	}
	key := as.PageAssetKey(rawURL)
	for _, k := range keys {
		if k == key {
			return domain.NewLeafAddress(ownerUUID, key).String()
		}
	}
	return ""
}

// urlSlug reduces rawURL to a short lowercase host-and-last-segment slug for a page key.
func (as *AssetService) urlSlug(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	var tail string
	for _, seg := range strings.Split(u.Path, "/") {
		if s := strings.TrimSpace(seg); s != "" {
			tail = s
		}
	}
	raw := host
	if tail != "" {
		raw = host + "-" + tail
	}
	var b strings.Builder
	prevHyphen := false
	for _, r := range strings.ToLower(raw) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevHyphen = false
		} else if !prevHyphen && b.Len() > 0 {
			b.WriteByte('-')
			prevHyphen = true
		}
		if b.Len() >= 40 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

// ServeStoreFile reads a file addressed relative to the library root. It backs
// relative markdown image sources, which name a path on disk rather than a
// stored asset, so it reads the filesystem directly instead of going through
// the Store.
//
// relPath is attacker-controlled (it arrives from a URL), so the resolved path
// is required to stay inside the root: cleaning alone is not enough, because
// Clean preserves leading "..".
func (as *AssetService) ServeStoreFile(relPath string) ([]byte, error) {
	if as.rootPath == "" {
		return nil, fmt.Errorf("asset: store not initialised")
	}
	root, err := filepath.Abs(as.rootPath)
	if err != nil {
		return nil, fmt.Errorf("asset: resolve store root: %w", err)
	}
	full := filepath.Join(root, filepath.Clean(filepath.FromSlash(relPath)))
	if !strings.HasPrefix(full+string(filepath.Separator), root+string(filepath.Separator)) {
		return nil, fmt.Errorf("asset: %q escapes the store root", relPath)
	}
	info, err := os.Stat(full)
	if err != nil {
		return nil, fmt.Errorf("asset: stat %q: %w", relPath, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("asset: %q is a directory", relPath)
	}
	return os.ReadFile(full)
}

// DetectContentType names the media type of asset bytes. It corrects the one
// case http.DetectContentType gets wrong for us: an SVG sniffs as text/xml or
// text/plain, and a browser will not render it as an image under either.
func (as *AssetService) DetectContentType(data []byte) string {
	ct := http.DetectContentType(data)
	if strings.HasPrefix(ct, "text/xml") || strings.HasPrefix(ct, "text/plain") {
		if bytes.Contains(data, []byte("<svg")) {
			return "image/svg+xml"
		}
	}
	return ct
}
