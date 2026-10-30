package processors

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"
)

// documentAssets writes a block's binary payload into the document that holds
// it. It is the ONE place that decides where such bytes live: the category
// follows the document's own kind (a note's assets belong to the Library, a
// buffer's to the working copy), and the saved asset is attached to the document
// so the ownership graph knows about it. Every kind that ingests bytes places
// them through here.
type documentAssets struct {
	svc block.BlockServices
	// kind names the owner in the log line, so a save can still be traced to the
	// block flavour that asked for it.
	kind string
}

// assetStemMax bounds a minted key's stem, in bytes, before any uniquifying
// suffix is added.
const assetStemMax = 80

// assetExtMax bounds the suffix a minted key keeps as its extension, dot
// included: long enough for .markdown, short enough that a name ending in a full
// stop contributes no extension.
const assetExtMax = 12

// mint saves data as a NEW asset of document uuid and returns the absolute sieve
// address (sieve://{uuid}/{key}) a block stores. The key is chosen by keyFor from
// preferredName — the name the bytes arrived under, or "" when they had none —
// and is never renamed afterwards. A key with no extension gets one sniffed from
// the magic bytes by the store, so the reference may name a longer key.
func (a documentAssets) mint(uuid, preferredName string, data []byte) (string, error) {
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

	key := a.keyFor(uuid, doc, preferredName)
	logger.Info(a.kind+": saving asset", "key", key, "uuid", uuid, "bytes", len(data))
	asset, err := a.svc.Assets.Save(cat, uuid, key, data)
	if err != nil {
		return "", err
	}

	if doc != nil {
		doc.Storable().AttachAsset(asset.Storable())
		if _, err := a.svc.Documents.Save(doc); err != nil {
			// Non-fatal: the asset is on disk and the block's src reaches it. Only
			// the ownership metadata is missing.
			logger.Warn(a.kind+": doc save after attach failed", "key", key, "err", err)
		}
	}

	return domain.NewLeafAddress(uuid, asset.Storable().Key()).String(), nil
}

// keyFor picks the key a new asset of document uuid is saved under.
//
// preferredName is reduced to its base name (after the last / or \); every run
// of characters other than Unicode letters, Unicode digits (unicode.IsLetter,
// unicode.IsDigit), combining marks (categories Mn and Mc, so a decomposed
// accent stays with its letter), "." "_" and "-" becomes one "-"; leading dots
// and leading combining marks are dropped. A final suffix of 2..assetExtMax bytes whose characters after the dot
// are all alphanumeric is the extension, lowercased; any other suffix stays part
// of the stem. The stem loses leading and trailing "-" and ".", and is cut to
// assetStemMax bytes. An empty stem becomes ident.New(), keeping the extension.
//
// The result is then made unique within the document, case-insensitively, by
// appending -2, -3, … to the stem: holiday.png, holiday-2.png, holiday-3.png. A
// key is taken when it equals a reserved name or an owned key, or — when it has
// no extension, so the store will append one — the stem of an owned key.
// doc's Owns() is the only record of what the directory holds, so a nil doc
// (one the document service cannot load) always gets an ident.New() stem.
func (a documentAssets) keyFor(uuid string, doc domain.Document, preferredName string) string {
	stem, ext := a.safeName(preferredName)
	if stem == "" || doc == nil {
		return ident.New() + ext
	}
	var owned []string
	for _, s := range doc.Storable().Owns() {
		owned = append(owned, filepath.Base(s.Key()))
	}
	key := stem + ext
	for n := 2; a.taken(uuid, owned, key); n++ {
		key = stem + "-" + strconv.Itoa(n) + ext
	}
	return key
}

// safeName splits name into the stem and extension keyFor builds a key from.
// Letters, digits and combining marks of any script survive; every other run of characters
// (spaces, punctuation, control characters) collapses to one "-". The stem cap
// is assetStemMax bytes, cut on a rune boundary.
func (a documentAssets) safeName(name string) (stem, ext string) {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	inRun := false
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r) || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
			inRun = false
		} else if !inRun {
			b.WriteByte('-')
			inRun = true
		}
	}
	stem = strings.TrimLeftFunc(b.String(), func(r rune) bool {
		return r == '.' || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r)
	})
	if e := filepath.Ext(stem); a.validExt(e) {
		stem, ext = strings.TrimSuffix(stem, e), strings.ToLower(e)
	}
	stem = strings.Trim(stem, "-.")
	if len(stem) > assetStemMax {
		cut := assetStemMax
		for !utf8.RuneStart(stem[cut]) {
			cut--
		}
		stem = strings.TrimRight(stem[:cut], "-.")
	}
	return stem, ext
}

// validExt reports whether a suffix (dot included) is short and alphanumeric
// enough to be kept as a key's extension.
func (a documentAssets) validExt(ext string) bool {
	if len(ext) < 2 || len(ext) > assetExtMax {
		return false
	}
	for _, r := range ext[1:] {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// reserved names the files the store keeps beside the assets of document uuid
// that a key could spell: the content file and its atomic-write temporary. The
// store's dot-files (.meta, .history) need no entry, since a key never starts
// with a dot.
func (a documentAssets) reserved(uuid string) []string {
	content := strings.ToLower(uuid) + ".md"
	return []string{content, content + ".tmp"}
}

// taken reports whether key would collide, ignoring case, with a reserved name
// of document uuid or with one of its owned keys.
func (a documentAssets) taken(uuid string, owned []string, key string) bool {
	key = strings.ToLower(key)
	for _, r := range a.reserved(uuid) {
		if key == r {
			return true
		}
	}
	bare := filepath.Ext(key) == ""
	for _, o := range owned {
		o = strings.ToLower(o)
		if o == key || (bare && strings.TrimSuffix(o, filepath.Ext(o)) == key) {
			return true
		}
	}
	return false
}

// read returns the bytes of the asset addr names.
func (a documentAssets) read(addr domain.Address) ([]byte, error) {
	if a.svc.Assets == nil {
		return nil, fmt.Errorf("%s: no asset service wired", a.kind)
	}
	data, err := a.svc.Assets.ServeAssetData(addr.Container, addr.Leaf)
	if err != nil {
		return nil, fmt.Errorf("%s: read %s: %w", a.kind, addr, err)
	}
	return data, nil
}

// copy mints the bytes of the asset src names as a new asset of document uuid,
// keyed from preferredName (see keyFor), and returns the new asset's absolute
// address.
// It copies even when src is already in uuid: every block holds its own asset.
func (a documentAssets) copy(src domain.Address, uuid, preferredName string) (string, error) {
	data, err := a.read(src)
	if err != nil {
		return "", err
	}
	return a.mint(uuid, preferredName, data)
}

// filename recovers the bare asset key from a stored src: the (decoded) leaf of
// an absolute sieve address, else the last path segment of a relative /{key}, a
// served route or a legacy `.assets/` filename.
func (a documentAssets) filename(src string) string {
	src = strings.TrimSpace(src)
	if addr, err := domain.ParseAddress(src); err == nil {
		return addr.Leaf
	}
	trimmed := strings.TrimPrefix(src, ".assets/")
	if trimmed == "" {
		return ""
	}
	return filepath.Base(trimmed)
}

// url is the served route the document renders an asset through, spelled the same
// way for both kinds that hold bytes. An http(s) src is already one; a src that
// is not an asset reference has no route, and yields "". An export writes the
// route back as the asset's address (block.DocView).
func (a documentAssets) url(uuid, src string) string {
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		return src
	}
	base := domain.Address{}
	if uuid != "" {
		base = domain.NewContainerAddress(uuid)
	}
	addr, err := domain.ResolveAssetReference(src, base)
	if err != nil {
		return ""
	}
	return store.AssetURL(addr.Container, addr.Leaf)
}
