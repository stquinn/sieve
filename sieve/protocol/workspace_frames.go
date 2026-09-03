package protocol

import (
	"encoding/json"

	"sieve/sieve/domain"
)

// CommandArgs is the message after the verb, as the caller's raw text/plain.
// It is one of the frame's TWO PROJECTIONS of that message — Body is the other
// — both authored by the caller, neither ever derived from the other. A caller
// with no block form (a filing verb, a menu) sends text alone.
//
// It is an object rather than a bare string so a command can grow named
// arguments without a wire break.
type CommandArgs struct {
	Text string `json:"text" doc:"the message after the verb as raw text; the string projection of what body carries as blocks"`
}

// CommandFrame dispatches one slash command.
type CommandFrame struct {
	Type string `json:"type"`
	// Family is an INTEGRITY expectation, not a policy gate: the dispatcher checks
	// it against the registered command's declared family and errors on mismatch.
	// Empty skips the check.
	Family        string      `json:"family,omitempty" doc:"the family the caller believes this command belongs to; empty skips the check"`
	Cmd           string      `json:"cmd" doc:"the verb, without its slash"`
	Args          CommandArgs `json:"args"`
	CorrelationID string      `json:"correlationId" doc:"required — a command with no correlation id is dropped, because its result could not be routed"`
	// Context is lens-authored: whatever the invoking surface knows about the
	// selection. It stays raw here because each command decodes the parts it cares
	// about and tolerates the rest.
	Context json.RawMessage `json:"context,omitempty" doc:"whatever the invoking surface knows about the selection, shaped by that surface"`
	// Attachments is composer-authored and a SIBLING of Context, never part of it:
	// `@` is a composer affordance and the composer is the same textarea that
	// dispatches `/`, so every command carries them and what a command does with
	// them is its own business. Keeping them out of Context is what stops a lens
	// forging one.
	Attachments []domain.Attachment `json:"attachments,omitempty" doc:"coordinates the composer attached with @; what a command does with them is its own business"`
	// Body is the message after the verb as the blocks it was authored as, in
	// order — the structured projection of the same message Args.Text carries as
	// raw text. The verb itself appears in neither: the rest of its line is the
	// head element here, or absent when the line was the verb alone. A command
	// consumes whichever projection makes sense for it.
	//
	// It is composer-authored and a SIBLING of Context for the same reason
	// Attachments is: a lens cannot forge one through the context bag.
	Body []CommandBlock `json:"body,omitempty" doc:"the message after the verb as ordered blocks; the structured projection of args.text — a command consumes whichever fits"`
}

// CommandCancelFrame cancels an in-flight command by its correlation id.
type CommandCancelFrame struct {
	Type          string `json:"type"`
	CorrelationID string `json:"correlationId"`
}

// MentionQueryFrame is the `@`-picker's typeahead question. It is a frame type
// of its own rather than a command: it is answered directly, with no job and no
// PENDING/COMPLETE lifecycle.
type MentionQueryFrame struct {
	Type string `json:"type"`
	Q    string `json:"q" doc:"the partial the user has typed"`
	// Limit is client-supplied, so the server floors it (an absent limit is still
	// a useful query) and caps it (an unbounded limit is an unbounded library scan
	// on the UI's own socket).
	Limit         int    `json:"limit,omitempty" doc:"how many candidates to return; the server floors and caps it"`
	CorrelationID string `json:"correlationId"`
}

// MentionResolveFrame asks where a coordinate opens. It exists so the frontend
// holds coordinates as OPAQUE STRINGS and never decodes the address grammar
// itself.
type MentionResolveFrame struct {
	Type          string `json:"type"`
	URI           string `json:"uri" doc:"a domain.Address coordinate: sieve://{container}[?version={n}], sieve://{container}/{leaf}[?version={n}]"`
	CorrelationID string `json:"correlationId"`
}

// SessionScrollFrame persists one tab's scroll offset, debounced up while the
// user scrolls and pulled again at tab deactivation.
//
// It is fire-and-forget and unanswered. It names its tab because the workspace
// channel is not bound to a document; a tab closed mid-flight is a no-op.
type SessionScrollFrame struct {
	Type   string `json:"type"`
	ID     string `json:"id" doc:"the tab whose offset this is"`
	Scroll int    `json:"scroll" doc:"the pixel offset from the top"`
}

// SpellIgnoreFrame stops a word being flagged for the rest of this run.
//
// Both spelling verbs ride the WORKSPACE channel rather than the document one
// because neither is about a document: a word accepted while reading one note is
// accepted in every note open beside it. Each is fire-and-forget and unanswered
// — the visible effect is the marks that follow, pushed per document on the
// channel that owns it.
//
// They are the FEATURE'S OWN verbs and not its lifecycle: a judgement about one
// word does not switch spelling on or off, which is what the feature-control
// frame is for.
type SpellIgnoreFrame struct {
	Type string `json:"type"`
	Word string `json:"word" doc:"the word as it was written; the server folds it to the form the dictionary is keyed by"`
}

// SpellLearnFrame adds a word to the user's durable dictionary, which survives
// a restart.
type SpellLearnFrame struct {
	Type string `json:"type"`
	Word string `json:"word" doc:"the word as it was written; the server folds it to the form the dictionary is keyed by"`
}

// CommandBlock is a block as the command wire carries it, in either direction:
// the kind, and everything that kind owns. It is deliberately narrower than the
// block itself — no position, no identity beyond what the attrs bag holds —
// because neither direction mutates a document. Inbound it is a block the
// composer authored; outbound it is a rendering instruction.
type CommandBlock struct {
	Kind  string                 `json:"kind"`
	Attrs map[string]interface{} `json:"attrs"`
}

// CommandResultFrame reports one step of a command's lifecycle. A command emits
// several: PENDING when the work is accepted, then COMPLETE or ERROR.
//
// It is correlated and therefore ack-shaped: it goes back on the socket the
// request arrived on, never to whichever socket currently owns the workspace
// channel.
type CommandResultFrame struct {
	Type          string        `json:"type"`
	CorrelationID string        `json:"correlationId"`
	Cmd           string        `json:"cmd"`
	Status        string        `json:"status" doc:"PENDING | COMPLETE | ERROR"`
	Block         *CommandBlock `json:"block,omitempty" doc:"present when this step produced a block to render"`
	Error         string        `json:"error,omitempty" doc:"present on ERROR"`
}

// NewCommandResultFrame builds one lifecycle step.
func NewCommandResultFrame(correlationID, cmd, status string) CommandResultFrame {
	return CommandResultFrame{
		Type:          TypeCommandResult,
		CorrelationID: correlationID,
		Cmd:           cmd,
		Status:        status,
	}
}

// WithBlock returns the step carrying the block it produced.
func (f CommandResultFrame) WithBlock(kind string, attrs map[string]interface{}) CommandResultFrame {
	f.Block = &CommandBlock{Kind: kind, Attrs: attrs}
	return f
}

// WithError returns the step carrying its failure message.
func (f CommandResultFrame) WithError(message string) CommandResultFrame {
	f.Error = message
	return f
}

// MentionResultFrame answers a typeahead.
type MentionResultFrame struct {
	Type          string             `json:"type"`
	CorrelationID string             `json:"correlationId"`
	Candidates    []domain.Candidate `json:"candidates" doc:"never null — the picker renders a list, and an empty one means no matches"`
}

// NewMentionResultFrame builds the typeahead answer. A nil slice is normalised
// to empty: a null would crash the picker rather than read as "no matches".
func NewMentionResultFrame(correlationID string, candidates []domain.Candidate) MentionResultFrame {
	if candidates == nil {
		candidates = []domain.Candidate{}
	}
	return MentionResultFrame{Type: TypeMentionResult, CorrelationID: correlationID, Candidates: candidates}
}

// MentionResolvedFrame answers "where does this coordinate open" with something
// the client can ACT on — a document to open, a block to reveal — and never
// anything it would have to parse.
//
// An unresolvable address is an ANSWER (found:false plus a reason), never a
// dropped frame. Every key is present in every reply, so a consumer reading uuid
// never has to tell "absent" from "empty".
type MentionResolvedFrame struct {
	Type          string `json:"type"`
	CorrelationID string `json:"correlationId"`
	URI           string `json:"uri" doc:"the coordinate that was asked about, echoed"`
	Found         bool   `json:"found"`
	UUID          string `json:"uuid" doc:"the container to open"`
	BlockID       string `json:"blockId" doc:"the block to reveal inside it; empty for a whole container"`
	Kind          string `json:"kind" doc:"the target's own noun, e.g. note"`
	Title         string `json:"title"`
	Error         string `json:"error,omitempty" doc:"why it did not resolve"`
}

// NewMentionResolvedFrame builds the found answer.
func NewMentionResolvedFrame(correlationID, uri string, target domain.OpenTarget) MentionResolvedFrame {
	return MentionResolvedFrame{
		Type:          TypeMentionResolved,
		CorrelationID: correlationID,
		URI:           uri,
		Found:         true,
		UUID:          target.UUID,
		BlockID:       target.BlockID,
		Kind:          target.Kind,
		Title:         target.Title,
	}
}

// NewMentionUnresolvedFrame builds the not-found answer. It is a separate
// constructor so found:true can never be emitted alongside an error.
func NewMentionUnresolvedFrame(correlationID, uri string, err error) MentionResolvedFrame {
	f := MentionResolvedFrame{Type: TypeMentionResolved, CorrelationID: correlationID, URI: uri}
	if err != nil {
		f.Error = err.Error()
	}
	return f
}

// InvalidateFrame tells every connected workspace socket that a subject changed
// and the views showing it are stale. It is a NUDGE, not a payload: the client
// refetches the affected view over HTTP.
type InvalidateFrame struct {
	Type  string `json:"type"`
	Topic Topic  `json:"topic"`
}

// NewInvalidateFrame builds the invalidation broadcast for one topic.
func NewInvalidateFrame(topic Topic) InvalidateFrame {
	return InvalidateFrame{Type: TypeInvalidate, Topic: topic}
}

// ContainerDeletedFrame is NEWS, not an instruction: the container it names is
// already gone from the store, and every workspace socket hears so. A client
// RECONCILES against it — drops whatever it still holds for that uuid (its tab
// bookkeeping, its editor, that editor's document socket) — rather than being
// asked to perform a deletion of its own.
//
// Acting on it is IDEMPOTENT: a client that never held the container does
// nothing, and one that hears the same news twice does nothing the second time.
// It carries a uuid rather than a topic, because what went stale is the client's
// own state and not a view to refetch.
//
// It is emitted BEFORE the deleting request renders its response, so on loopback
// a client normally tears its editor down first and the response's out-of-band
// swap then mounts the new active tab.
type ContainerDeletedFrame struct {
	Type string `json:"type"`
	UUID string `json:"uuid" doc:"the container that no longer exists"`
}

// NewContainerDeletedFrame builds the reconciliation broadcast for one container.
func NewContainerDeletedFrame(uuid string) ContainerDeletedFrame {
	return ContainerDeletedFrame{Type: TypeContainerDeleted, UUID: uuid}
}

// ContainerSavedFrame is NEWS: the container it names has just reached disk, and
// every workspace socket hears so. A client holding an editor for that uuid
// clears its dirty state; one that does not, does nothing.
//
// It is the ONE saved-signal and every writer publishes it — the explicit flush,
// the debounce autosave, a finished job's write, the prompt pseudo-document's
// HTTP save. It names its uuid because the workspace channel is bound to the
// window, not to a document.
//
// Version makes the fact ORDERABLE: the store stamps a strictly increasing
// version on every write, so a listener can tell a save newer than the state it
// knew from a debounce write already in flight. A container with no version
// history reports 0, and a real document's first save is version 1.
//
// A FAILED save emits nothing — the document simply stays dirty, and the server
// logs the reason.
type ContainerSavedFrame struct {
	Type    string `json:"type"`
	UUID    string `json:"uuid" doc:"the container whose content just reached disk"`
	Version int    `json:"version" doc:"the document version this save produced; 0 when the container keeps no version history"`
}

// NewContainerSavedFrame builds the saved broadcast for one container.
func NewContainerSavedFrame(uuid string, version int) ContainerSavedFrame {
	return ContainerSavedFrame{Type: TypeContainerSaved, UUID: uuid, Version: version}
}

// JobsSnapshot is every job the UI can see, in insertion order.
type JobsSnapshot struct {
	Active []domain.JobInfo `json:"active" doc:"jobs a worker is running now; never null"`
	Queued []domain.JobInfo `json:"queued" doc:"jobs waiting for a worker; never null"`
}

// JobsChangedFrame broadcasts the whole job snapshot whenever it changes. Unlike
// an invalidate it carries data, and it is the ONLY way the snapshot reaches a
// client — there is no endpoint to poll — so a workspace socket is sent one the
// moment it connects.
type JobsChangedFrame struct {
	Type string `json:"type"`
	// The snapshot is EMBEDDED, so active/queued sit at the top level of the frame
	// rather than nested under a key.
	JobsSnapshot `doc:"the whole snapshot, not a delta"`
}

// NewJobsChangedFrame builds the jobs broadcast. Either nil list is normalised
// to empty: the consumer reads a length, and a null there is a crash rather than
// "no jobs".
func NewJobsChangedFrame(snapshot JobsSnapshot) JobsChangedFrame {
	if snapshot.Active == nil {
		snapshot.Active = []domain.JobInfo{}
	}
	if snapshot.Queued == nil {
		snapshot.Queued = []domain.JobInfo{}
	}
	return JobsChangedFrame{Type: TypeJobsChanged, JobsSnapshot: snapshot}
}
