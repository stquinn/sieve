package command

import (
	"fmt"

	"sieve/sieve/services"
)

// DocumentFiler is the port the filing commands drive. The work itself lives in
// editor/, which this package cannot import (the edge runs block → ai → command
// → services), so the concrete EditorService is handed in at the composition
// root — the same shape /migrate-ids uses for its sweeper.
//
// Every method is fire-and-forget: each submits a job to the ai worker pool and
// returns, so what a filing command's own job does is ASK, not wait.
type DocumentFiler interface {
	// FileDocument evaluates a document and files it where the answer says.
	FileDocument(id string)
	// UpdateMetadata re-evaluates a document's metadata and files nothing.
	UpdateMetadata(id string)
	// KeepAndFile files a document the user has explicitly kept.
	KeepAndFile(uuid string)
}

// NotesInvalidator is told that the note tree changed and every view showing it
// is stale. It carries no topic because command/ cannot name a wire type (the
// edge runs protocol → block → ai → command), so the caller that CAN chooses
// which topic a "notes changed" means.
type NotesInvalidator interface {
	NotesChanged()
}

// FilingCommand asks the AI to look at the document the invocation came from
// and act on what it finds. The three verbs differ only in which act that is,
// so they are one type: naming a command's identity and its action together at
// construction keeps the shared preconditions — a document, and one that still
// exists — in a single place.
//
// It produces no result block. Filing shows up as the moved document and the
// job in the status bar; a block saying "asked" would be noise in the document
// the user is reading.
type FilingCommand struct {
	name        string
	description string
	docs        *services.DocumentService
	act         func(id string) error
}

// NewFileCommand builds /file: evaluate this document and file it.
func NewFileCommand(filer DocumentFiler, docs *services.DocumentService) *FilingCommand {
	return &FilingCommand{
		name:        "file",
		description: "File this document where the AI's evaluation says it belongs",
		docs:        docs,
		act:         func(id string) error { filer.FileDocument(id); return nil },
	}
}

// NewMetadataCommand builds /metadata: re-evaluate the metadata, file nothing.
func NewMetadataCommand(filer DocumentFiler, docs *services.DocumentService) *FilingCommand {
	return &FilingCommand{
		name:        "metadata",
		description: "Re-evaluate this document's title, summary and tags",
		docs:        docs,
		act:         func(id string) error { filer.UpdateMetadata(id); return nil },
	}
}

// NewKeepAndFileCommand builds /keep-and-file: the user says keep, the AI says
// where.
//
// The user_intent write happens HERE and nowhere downstream, because it is
// user-owned: this command is the explicit user action that means "keep", and
// no AI path may write that field.
//
// It is the one filing verb that invalidates immediately: the intent write is
// synchronous and visible in the sidebar, where the other two verbs only ask the
// AI and change nothing yet. A wiring with no invalidator still files — the file
// watcher notices the same write, just a debounce later.
func NewKeepAndFileCommand(filer DocumentFiler, docs *services.DocumentService, notes NotesInvalidator) *FilingCommand {
	return &FilingCommand{
		name:        "keep-and-file",
		description: "Mark this document as kept, then file it",
		docs:        docs,
		act: func(id string) error {
			doc, err := docs.LoadByUUID(id)
			if err != nil {
				return err
			}
			if _, err := docs.SetUserIntent(doc, "keep"); err != nil {
				return err
			}
			if notes != nil {
				notes.NotesChanged()
			}
			filer.KeepAndFile(id)
			return nil
		},
	}
}

func (c *FilingCommand) Name() string        { return c.name }
func (c *FilingCommand) Description() string { return c.description }
func (c *FilingCommand) Family() string      { return FamilyAI }

// ResultKind is empty: filing answers with a moved document, not a block.
func (c *FilingCommand) ResultKind() string { return "" }

// Build refuses up front what the retired endpoints refused with a 404 — a
// command with no document to act on, or one naming a document that is gone.
// The invocation site names it: a lens authoring the context puts the open
// document in DocUUID, which is the same id the endpoints took in their path.
func (c *FilingCommand) Build(_ string, ctx Context) (Job, error) {
	id := ctx.DocUUID
	if id == "" {
		return Job{}, fmt.Errorf("/%s needs a document — the invocation carried none", c.name)
	}
	if c.docs == nil {
		return Job{}, fmt.Errorf("/%s is unavailable — no library is attached", c.name)
	}
	if _, err := c.docs.LoadByUUID(id); err != nil {
		return Job{}, fmt.Errorf("/%s: document not found: %s", c.name, id)
	}

	return Job{
		Label:   "/" + c.name,
		Pending: nil,
		Work: func() (Block, error) {
			return Block{}, c.act(id)
		},
	}, nil
}
