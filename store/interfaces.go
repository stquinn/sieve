package store

// Storable is the base contract for anything the Store can persist. It is a
// pure value object — no logic, no path awareness, no knowledge of how or
// where it lives on disk.
//
// Every Storable is created by the Store — never directly by the caller. The
// Store stamps Category, derives ExternalRef by walking the ownership graph,
// and infers Encoding for assets. Callers cannot set these fields.
type Storable interface {
	// Key returns the logical identity of this Storable within its Category.
	Key() string

	// Category returns the Category this Storable belongs to. Stamped at
	// creation and immutable — use Store.Move to change category.
	Category() Category

	// Body returns the raw content bytes. For MetaStorables the body is pure
	// markdown with frontmatter stripped; the Store owns serialisation.
	Body() []byte

	// ExternalRef returns the string used to reference this Storable from
	// outside the Store — in editor content, markdown image links, and AI CLI
	// calls. Derived by walking the ownership graph at read time; never stored.
	ExternalRef() string

	// Versions returns lightweight history refs ordered newest-first. Content
	// is not included; call Store.RetrieveVersion to fetch a snapshot.
	Versions() []VersionRef
}

// MetaStorable extends Storable with structured metadata. Used for notes and
// buffers. The Store serialises Meta as YAML frontmatter; no code outside the
// store package ever constructs or parses frontmatter directly.
//
// SetBody, SetMeta are the in-place mutable surfaces. Changes are local until
// Store.Save is called, which returns a new Storable stamping the updated
// version and modified timestamp.
type MetaStorable interface {
	Storable

	// Meta returns the raw metadata map. In business code, access fields
	// through a typed DocumentMeta accessor rather than the raw map.
	Meta() map[string]string

	// SetBody replaces the body content. The change is local until Store.Save.
	SetBody([]byte)

	// SetMeta replaces the metadata map. The change is local until Store.Save.
	SetMeta(map[string]string)
}

// AssetStorable extends Storable for binary content such as images and voice
// notes. The Store infers and stamps Encoding from magic bytes at Create time;
// the caller never declares the encoding.
type AssetStorable interface {
	Storable

	// Encoding returns the encoding inferred from the raw bytes at creation.
	Encoding() Encoding
}

// FolderStorable is a first-class node in the ownership graph. Folders own
// other Storables — they are not path prefixes or naming conventions. The
// Store creates, renames, and reparents folders through the same interface as
// any other Storable.
//
// Stash v1 supports one level of folders. Arbitrary nesting is structurally
// free (FolderStorable owning FolderStorable requires no Store changes) but is
// gated by business layer policy.
type FolderStorable interface {
	Storable

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
	// Create makes a new Storable in category with the given key and body. If
	// key is empty the Store generates one. The Store stamps Category, derives
	// ExternalRef, and infers Encoding for AssetStorables. Returns the created
	// Storable.
	Create(category Category, key string, body []byte) (Storable, error)

	// Save persists the current state of s. The Store stamps the version and
	// modified timestamp, writes a snapshot unconditionally, and checks the
	// optimistic lock. Returns ErrStaleStorable if s is based on a version that
	// is no longer current. Returns a new Storable — the input is stale after
	// this call.
	Save(s Storable) (Storable, error)

	// Load retrieves the Storable identified by category and key. ExternalRef
	// is derived from the current ownership graph.
	Load(category Category, key string) (Storable, error)

	// Delete removes s and its entire version history from the Store.
	Delete(s Storable) error

	// List returns all Storables in category whose key begins with prefix. Pass
	// an empty prefix to list the entire category. For FileStore, this scans
	// the directory tree and reconstructs the ownership graph.
	List(category Category, prefix string) ([]Storable, error)

	// Move transfers s to a different Category. Returns a new Storable in the
	// target category; the source is removed.
	Move(s Storable, to Category) (Storable, error)

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
}
