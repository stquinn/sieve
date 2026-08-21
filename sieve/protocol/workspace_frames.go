package protocol

import (
	"encoding/json"

	"sieve/sieve/domain"
)

// CommandArgs is what the user typed after the verb. It is an object rather than
// a bare string so a command can grow named arguments without a wire break.
type CommandArgs struct {
	Text string `json:"text"`
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
}

// CommandCancelFrame cancels an in-flight command by its correlation id.
type CommandCancelFrame struct {
	Type          string `json:"type"`
	CorrelationID string `json:"correlationId"`
}

// MentionQueryFrame is the `@`-picker's typeahead question.
//
// It is a SIBLING FRAME TYPE, not a command: a typeahead needs a sub-100ms answer
// with no job, no worker pool and no result block, none of which a command's
// PENDING/COMPLETE lifecycle can give it.
type MentionQueryFrame struct {
	Type string `json:"type"`
	Q    string `json:"q" doc:"the partial the user has typed"`
	// Limit is client-supplied, so the server floors it (an absent limit is still
	// a useful query) and caps it (an unbounded limit is an unbounded library scan
	// on the UI's own socket).
	Limit         int    `json:"limit,omitempty" doc:"how many candidates to return; the server floors and caps it"`
	CorrelationID string `json:"correlationId"`
}

// MentionResolveFrame asks where a coordinate opens.
//
// It exists so the frontend holds coordinates as OPAQUE STRINGS. Decoding an
// address in JavaScript is a second implementation of a grammar Go owns, and its
// failure mode is silence: an unrecognised form falls through the guard and the
// click does nothing.
type MentionResolveFrame struct {
	Type          string `json:"type"`
	URI           string `json:"uri" doc:"a domain.Address coordinate: container:{uuid}[@v{n}], block:{uuid}, block:{container}[@v{n}]/{handle}"`
	CorrelationID string `json:"correlationId"`
}

// SessionScrollFrame persists one tab's scroll offset — the per-user VIEW
// coordinate a surface debounces up while the user scrolls, plus the pull at tab
// deactivation.
//
// It is fire-and-forget and unanswered: this is caret-class state, not a shared
// UI change, so there is nothing to broadcast and nothing to swap. It names its
// tab because the workspace channel is not bound to a document — and a tab closed
// mid-flight is a harmless no-op.
type SessionScrollFrame struct {
	Type   string `json:"type"`
	ID     string `json:"id" doc:"the tab whose offset this is"`
	Scroll int    `json:"scroll" doc:"the pixel offset from the top"`
}

// CommandResultBlock is the block a command produced, projected to what the
// client renders it from. It is deliberately narrower than the block itself: a
// result is a rendering instruction, not a document mutation, so nothing beyond
// kind and attrs crosses.
type CommandResultBlock struct {
	Kind  string                 `json:"kind"`
	Attrs map[string]interface{} `json:"attrs"`
}

// CommandResultFrame reports one step of a command's lifecycle. A command emits
// several: PENDING when the work is accepted, then COMPLETE or ERROR.
//
// It is correlated and therefore ack-shaped, so it goes back on the socket the
// request arrived on — never to whichever socket currently owns the workspace
// channel, which is how a second tab silently swallowed another tab's answers.
type CommandResultFrame struct {
	Type          string              `json:"type"`
	CorrelationID string              `json:"correlationId"`
	Cmd           string              `json:"cmd"`
	Status        string              `json:"status" doc:"PENDING | COMPLETE | ERROR"`
	Block         *CommandResultBlock `json:"block,omitempty" doc:"present when this step produced a block to render"`
	Error         string              `json:"error,omitempty" doc:"present on ERROR"`
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
	f.Block = &CommandResultBlock{Kind: kind, Attrs: attrs}
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

// NewMentionResultFrame builds the typeahead answer. A nil slice is normalised to
// empty: a null would be an undefined-length crash in the picker rather than "no
// matches".
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
// An unresolvable address is an ANSWER (found:false plus a reason), not a dropped
// frame: a request with no reply is the same silence in a slower costume. Every
// key is present in every reply, resolvable or not, so a consumer reading uuid
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
// refetches the affected view over HTTP, so hypermedia stays hypermedia and only
// the signalling moved onto this wire.
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
// CONTAINER, not "document", because that is the word the coordinate system
// uses: a block-holding document is addressed as container:{uuid}, and further
// container kinds are coming. Nothing here reads the container's kind — the
// reconciliation is one uuid the client no longer has anything to hold — so
// naming the frame after today's only kind would have to be renamed by the next.
//
// The past tense is the whole design. There is no permission to negotiate and no
// ordering to agree: a client that never held the container does nothing, and
// one that hears the same news twice does nothing the second time. That is also
// why it carries a uuid rather than a topic — nothing is refetched, because what
// went stale is the client's own state, not a view.
//
// The delete's own HTTP response is not a competing signal. A note deletion
// emits this frame BEFORE it renders, so on loopback the client normally
// reconciles first and tears down the editor that is still MOUNTED — the
// ordinary path, not a hazard: the teardown is the same unmount and
// channel-close the editor performs when a tab is switched away from, and the
// response's out-of-band editor swap then mounts the new active tab from
// scratch.
type ContainerDeletedFrame struct {
	Type string `json:"type"`
	UUID string `json:"uuid" doc:"the container that no longer exists"`
}

// NewContainerDeletedFrame builds the reconciliation broadcast for one container.
func NewContainerDeletedFrame(uuid string) ContainerDeletedFrame {
	return ContainerDeletedFrame{Type: TypeContainerDeleted, UUID: uuid}
}

// ContainerSavedFrame is NEWS in the same past tense its deleted sibling
// carries: the container it names has just reached disk, and every workspace
// socket hears so. A client that holds an editor for that uuid clears its dirty
// state; one that does not, does nothing.
//
// It is the ONE saved-signal, and it is here rather than on the document
// channel because a save is a FACT ABOUT A CONTAINER, not the outcome of one
// client's request. Every writer therefore publishes the same frame — the
// explicit flush, the debounce autosave, a finished job's write, and the prompt
// pseudo-document's HTTP save, which by riding this wire gains a saved-signal
// for the first time. That is also why it names its uuid: the workspace channel
// is bound to the window, not to a document.
//
// Version is what makes the fact ORDERABLE, which a client that waited for its
// own save to land needs: the store stamps a strictly increasing version on
// every write, so a listener can tell a save newer than the state it knew from
// a debounce write that was already in flight when it asked. A container with no
// version history reports 0 — the prompt pseudo-document is a plain file with no
// metadata — and a real document's first save is version 1, so 0 is unambiguous.
//
// A FAILED save emits nothing. There is no "save failed" frame to pair with
// this one, because the absence IS the signal: the document stays dirty, which
// is exactly what the user needs to see, and the server logs the reason.
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
// an invalidate it carries data: the consumers are JS reading counts and labels,
// not a view that could refetch itself, and the jobs it describes were dispatched
// on this very wire.
//
// It is also the ONLY way the snapshot reaches a client — there is no endpoint to
// poll — so a workspace socket is sent one the moment it connects.
type JobsChangedFrame struct {
	Type string `json:"type"`
	// The snapshot is EMBEDDED, so active/queued sit at the top level of the frame
	// rather than nested under a key: envelope and payload at one level, uniform
	// with every other frame.
	JobsSnapshot `doc:"the whole snapshot, not a delta"`
}

// NewJobsChangedFrame builds the jobs broadcast. Either nil list is normalised
// to empty for the same reason a mention result is: the consumer reads a length,
// and a null there is a crash rather than "no jobs".
func NewJobsChangedFrame(snapshot JobsSnapshot) JobsChangedFrame {
	if snapshot.Active == nil {
		snapshot.Active = []domain.JobInfo{}
	}
	if snapshot.Queued == nil {
		snapshot.Queued = []domain.JobInfo{}
	}
	return JobsChangedFrame{Type: TypeJobsChanged, JobsSnapshot: snapshot}
}
