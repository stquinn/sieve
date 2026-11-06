package store

// The .meta type values. A type is what a directory in the store holds; it says
// nothing about where that directory lives. TypeDocument and TypeBlock carry a
// content file, TypeFolder does not.
const (
	TypeDocument = "document"
	TypeBlock    = "block"
	TypeFolder   = "folder"
)

// MetaKeyKind is the metadata key naming a TypeBlock storable's block kind. The
// Store persists it and never interprets it.
const MetaKeyKind = "kind"

// Storable is the base contract for anything the Store can persist. It is a
// pure value object — no logic, no path awareness, no knowledge of how or
// where it lives on disk.
//
// Every Storable is created by the Store — never directly by the caller. The
// Store stamps Category, derives ExternalRef by walking the ownership graph,
// and infers Encoding for assets. Callers cannot set these fields.
type Storable interface {
	// Key returns the logical identity of this Storable within its Category (UUID).
	Key() string

	// Category returns the Category this Storable belongs to. Stamped at
	// creation and immutable — use Store.Move to change category.
	Category() Category

	// Body returns the raw content bytes. The Store never interprets them: what
	// they mean is decided by the MetaStorable's Type and the service that owns
	// that type. An AssetStorable holds no bytes: its Body reads the asset as it
	// is stored at the time of the call, costs a read each call, and is nil when
	// the asset cannot be read.
	Body() []byte

	// ExternalRef returns the string used to reference this Storable from
	// outside the Store — in editor content, markdown image links, and AI CLI
	// calls. Derived by walking the ownership graph at read time; never stored.
	ExternalRef() string

	// Versions returns lightweight history refs ordered newest-first. Content
	// is not included; call Store.RetrieveVersion to fetch a snapshot.
	Versions() []VersionRef

	// IsModified returns true if the storable has been changed in-place
	// since creation or loading.
	IsModified() bool
}

// MetaStorable extends Storable with structured metadata. It is the root of
// everything stored as a directory holding a .meta, a content file, versions and
// assets; its Type says which service owns it. The Store owns the .meta format;
// no code outside the store package ever constructs or parses it directly.
//
// SetBody, SetMeta are the in-place mutable surfaces. Changes are local until
// Store.Save is called, which returns a new Storable stamping the updated
// version and modified timestamp.
type MetaStorable interface {
	Storable

	// Type returns the .meta type (TypeDocument, TypeBlock). Stamped at creation
	// and immutable: SetMeta cannot change it, and neither can Move.
	Type() string

	// Meta returns the raw metadata map. In business code, access fields
	// through a typed DocumentMeta accessor rather than the raw map.
	Meta() map[string]string

	// SetBody replaces the body content. The change is local until Store.Save.
	SetBody([]byte)

	// SetMeta replaces the metadata map. The change is local until Store.Save.
	SetMeta(map[string]string)

	// Owns returns the assets owned by this document.
	Owns() []Storable

	// AttachAsset adds an asset to the ownership list, replacing the one of the same key.
	AttachAsset(a Storable)
}

// AssetStorable extends Storable for binary content such as images and voice
// notes. The Store infers and stamps Encoding from the asset's leading bytes
// when the storable is built; the caller never declares the encoding.
type AssetStorable interface {
	Storable

	// Encoding returns the encoding inferred from the asset's leading bytes.
	Encoding() Encoding

	// BlkID returns the block identifier for this asset — the filename stem
	// (key without extension), e.g. "blk-a1b2" for "blk-a1b2.png".
	// Derived once at load/create time from the filename.
	BlkID() string

	// Size returns the asset's current length in bytes without reading it; 0
	// when it cannot be measured.
	Size() int64
}

// FolderStorable is a first-class node in the ownership graph. Folders own
// other Storables — they are not path prefixes or naming conventions. The
// Store creates, renames, and reparents folders through the same interface as
// any other Storable.
//
// Sieve v1 supports one level of folders. Arbitrary nesting is structurally
// free (FolderStorable owning FolderStorable requires no Store changes) but is
// gated by business layer policy.
type FolderStorable interface {
	Storable

	// Name returns the human-readable name of this folder (the directory
	// basename). Use this in the business layer — never parse ExternalRef.
	Name() string

	// Owns returns the direct children of this folder. Each child is a
	// MetaStorable or FolderStorable.
	Owns() []Storable
}

// Store is the single persistence boundary. It is the factory, serialiser, and
// lifecycle manager for all Storables.
//
// Every mutating operation returns a new Storable — the input is stale the
// moment the call returns. Callers must replace their reference with the
// returned value.
//
// Versioning is automatic: every Save call writes a snapshot unconditionally.
// No business layer involvement and no UI action required.
type Store interface {
	CreateText(category Category, key string, body []byte) (Storable, error)

	// Create makes a new Storable in category with the given key and body. If
	// key is empty the Store generates one. The Store stamps Category, derives
	// ExternalRef, and infers Encoding for AssetStorables. Returns the created
	// Storable.
	CreateMetaText(category Category, key string, body []byte) (MetaStorable, error)

	// CreateTyped makes a new MetaStorable of the given content-bearing type,
	// seeded with meta. body is stored verbatim, never parsed for frontmatter. A
	// type that carries no content is an error. As with CreateMetaText an empty
	// key is generated, and uuid, version and timestamps absent from meta are
	// stamped.
	CreateTyped(category Category, key string, contentType string, meta map[string]string, body []byte) (MetaStorable, error)

	// CreateAsset creates a new AssetStorable. The key is managed internally
	// by the store based on the parent document that logically owns it.
	CreateAsset(category Category, parentKey string, assetID string, body []byte) (AssetStorable, error)

	// AppendAsset appends data to the asset assetKey of the MetaStorable
	// uuidParent, creating the asset when absent. assetKey is a filename,
	// extension included. The bytes already stored are neither read nor
	// rewritten, and the returned asset holds none of them: its Body reads the
	// asset as stored at the time of the call to Body.
	AppendAsset(category Category, uuidParent string, assetKey string, data []byte) (AssetStorable, error)

	CreateOrLoadFolder(category Category, name string) (FolderStorable, error)

	// Save persists the current state of s. The Store stamps the version and
	// modified timestamp, writes a snapshot unconditionally, and checks the
	// optimistic lock. Returns ErrStaleStorable if s is based on a version that
	// is no longer current. Returns a new Storable — the input is stale after
	// this call.
	Save(s Storable) (Storable, error)

	// Load retrieves the Storable identified by category and key. ExternalRef
	// is derived from the current ownership graph.
	Load(category Category, key string) (Storable, error)

	LoadByUUID(uuid string) (Storable, error)

	LoadAsset(category Category, uuidParent string, assetKey string) (AssetStorable, error)

	// DeleteAsset removes the asset assetKey owned by document uuidParent. The key
	// must name an asset the document owns on disk; anything else — the document's
	// own content, a path — is an error and nothing is removed. On success the
	// document's ownership list no longer holds the asset.
	DeleteAsset(category Category, uuidParent string, assetKey string) error

	LoadFolder(category Category, key string) (FolderStorable, error)

	// Delete removes s and its entire version history from the Store.
	Delete(s Storable) error

	// ForgetUUIDs drops any identity a Store still resolves for uuids whose
	// storables it has already destroyed. Deleting a folder erases everything
	// beneath it in ONE call that names only the folder, so a Store that
	// resolves uuids from anything other than a live read of the tree is left
	// answering for documents that no longer exist. The caller passes the uuids
	// it collected before the delete; a Store that resolves from disk on every
	// lookup implements this as a no-op.
	ForgetUUIDs(uuids []string)

	// List returns all Storables in category whose key begins with prefix. Pass
	// an empty prefix to list the entire category. For FileStore, this scans
	// the directory tree and reconstructs the ownership graph.
	List(category Category, prefix string) ([]Storable, error)

	ListFrom(categories []Category, prefix string) ([]Storable, error)

	// Move transfers s to a different Category and logic Key. Returns a new Storable in the
	// target category; the source is removed.
	Move(s Storable, to Category) (Storable, error)

	// PrepareCategory establishes any necessary directories or infrastructure
	// for the given category before items can be saved within it.
	PrepareCategory(category Category) error

	// Reparent moves s under folder. For FileStore this physically relocates
	// the file; ExternalRefs are correct on next read with no content
	// rewriting.
	Reparent(s Storable, folder FolderStorable) (Storable, error)

	// Rename changes the name component of s's key. Returns a new Storable
	// with the updated key and a corrected ExternalRef.
	Rename(s Storable, name string) (Storable, error)

	// RetrieveVersion fetches the snapshot identified by ref. Returns a
	// VersionedStorable — a distinct type from Storable so a snapshot cannot
	// be accidentally saved back as the current document.
	RetrieveVersion(s Storable, ref VersionRef) (VersionedStorable, error)

	// SaveMeta writes only the metadata for s — no snapshot, no version bump.
	// Use for focus count increments, AI evaluation updates, tag changes, renames.
	SaveMeta(s MetaStorable) (MetaStorable, error)
}
