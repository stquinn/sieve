package editor

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// ChatDescriber describes a chat from its thread. ai.AIService implements it.
type ChatDescriber interface {
	// Tier is the AI's tier now; nothing is described while it is domain.TierDumb.
	Tier() domain.Tier
	// DescribeChat describes the chat uuid from turns, its answered exchanges oldest first, each
	// its question and answer as block.ChatView.Answered renders them.
	DescribeChat(uuid string, turns []string) (domain.NoteMetadata, error)
}

// ChatSettings is where the namer reads how long a chat takes to settle. services.StateService
// implements it.
type ChatSettings interface {
	LoadSettings() domain.Settings
}

// The errors NameNow returns for a chat it cannot name now; ChatNamer.Refusal says each in words.
var (
	// ErrChatNamingUnavailable is the AI's tier being dumb.
	ErrChatNamingUnavailable = errors.New("chat: no AI is configured to name a chat")
	// ErrNothingToName is a chat with no answered exchange.
	ErrNothingToName = errors.New("chat: the chat has no answered exchange")
)

// chatNamingJob prefixes the JobID of the job that describes a chat; the chat's uuid follows.
const chatNamingJob = "name-chat:"

// ChatNamer gives chats their names, summaries, keywords and categories. A chat grows by its
// answered exchanges (block.ChatView.Answered), and its .meta says how many its description was of
// (domain.Chat.Description). A chat is due when it has grown since: at once when it has never been
// described, which is how it is described after its first answer, otherwise once it has settled,
// no question asked of it and no job of it running for the settle time
// (domain.ChatSettings.Settle) counted from when it was last changed (domain.Chat.Modified), across
// a restart alike. A due chat is described by one job on the AI pool, at most one per chat at a
// time, and ChatService.Describe keeps what it answers. A chat that settles without having grown
// is not described again.
//
// The namer hears that a job in a chat ended (ChatAnsweredListener), and finds what else is due
// when it starts and whenever its one timer fires; the timer is set for the earliest moment a due
// chat can settle. NameNow describes a chat at once, due or not. Rename gives a name by hand,
// which a description keeps; a blank one hands naming back, the chat then due at once. A
// description that fails leaves the chat undescribed until it grows again. Nothing is described
// while the AI's tier is dumb. It is safe for concurrent use.
type ChatNamer struct {
	chats     *services.ChatService
	describer ChatDescriber
	engine    *services.JobEngine
	jobs      *services.JobTracker // nil is no job of any chat running
	settings  ChatSettings
	listener  ChatListener // nil leaves a new name unannounced
	now       func() time.Time
	// afterFunc calls f once d has passed, unless the stop it returns is called first.
	afterFunc func(d time.Duration, f func()) (stop func() bool)

	mu      sync.Mutex
	running bool
	// naming holds the chats whose job is queued or running.
	naming map[string]bool
	// failed holds, for a chat whose last description failed, how many answered exchanges it
	// was of: the chat is not due again until it has more.
	failed map[string]int
	// stopTimer stops the pending wake; nil when none is pending. wakes numbers the timers, so
	// one that fires after another replaced it does nothing.
	stopTimer func() bool
	wakes     uint64
}

var _ ChatAnsweredListener = (*ChatNamer)(nil)

// NewChatNamer is the namer of the chats chats holds, which describes them through describer,
// runs its jobs on engine, reads whether a chat has a job running from jobs, reads the settle
// time from settings and tells listener of each chat's new name. It names nothing until Start.
func NewChatNamer(chats *services.ChatService, describer ChatDescriber, engine *services.JobEngine, jobs *services.JobTracker, settings ChatSettings, listener ChatListener) *ChatNamer {
	return &ChatNamer{
		chats: chats, describer: describer, engine: engine, jobs: jobs, settings: settings, listener: listener,
		now: time.Now, naming: map[string]bool{}, failed: map[string]int{},
		afterFunc: func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop },
	}
}

// Start begins naming: the chats held are read at once. It does nothing while the namer runs.
func (n *ChatNamer) Start() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.running {
		return
	}
	n.running = true
	n.setTimer(n.now())
}

// Stop ends naming; a job already running finishes and its description is kept.
func (n *ChatNamer) Stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.running = false
	if n.stopTimer != nil {
		n.stopTimer()
		n.stopTimer = nil
	}
	n.wakes++
}

// ChatAnswered is a job in chat uuid having ended: the chat is read again at once, and named when
// it is due.
func (n *ChatNamer) ChatAnswered(string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.running {
		n.setTimer(n.now())
	}
}

// NameNow submits the job that describes chat uuid, whether or not it is due; it does nothing
// while that chat's job runs. A uuid naming no chat is domain.ErrNotChat, a dumb AI
// ErrChatNamingUnavailable and a chat with no answered exchange ErrNothingToName; Refusal says
// each in words.
func (n *ChatNamer) NameNow(uuid string) error {
	if n.describer.Tier() == domain.TierDumb {
		return ErrChatNamingUnavailable
	}
	chat, err := n.chats.Load(uuid)
	if err != nil {
		return err
	}
	if len(n.answered(chat)) == 0 {
		return fmt.Errorf("%w: %s", ErrNothingToName, uuid)
	}
	n.mu.Lock()
	if n.naming[uuid] {
		n.mu.Unlock()
		return nil
	}
	n.naming[uuid] = true
	n.mu.Unlock()
	logger.Info("chat: naming a chat now, as asked", "chat", uuid)
	n.submit(uuid, chat.Name())
	return nil
}

// Rename gives chat uuid name, trimmed, by hand (ChatService.Rename) and announces what the chat
// is then called. A blank name hands naming back: the chat is read again at once, and described
// when it has an answered exchange. A uuid naming no chat is domain.ErrNotChat.
func (n *ChatNamer) Rename(uuid, name string) error {
	chat, err := n.chats.Load(uuid)
	if err != nil {
		return err
	}
	before := chat.Name()
	renamed, err := n.chats.Rename(uuid, name)
	if err != nil {
		return err
	}
	n.announce(before, renamed)
	if strings.TrimSpace(name) == "" {
		n.mu.Lock()
		delete(n.failed, uuid)
		if n.running {
			n.setTimer(n.now())
		}
		n.mu.Unlock()
	}
	return nil
}

// Refusal is what a person asking NameNow is told of err, the error it returned.
func (n *ChatNamer) Refusal(err error) string {
	switch {
	case errors.Is(err, ErrChatNamingUnavailable):
		return "No AI is configured in Settings, so nothing can name this chat."
	case errors.Is(err, ErrNothingToName):
		return "This chat has no answer to name it from yet."
	case errors.Is(err, domain.ErrNotChat):
		return "This is not a chat Sieve holds."
	default:
		return "The chat could not be named: " + err.Error()
	}
}

// wake is the timer numbered wake firing: every chat is read, each due chat that has settled is
// named, and the timer is set for the earliest a due chat that has not can settle.
func (n *ChatNamer) wake(wake uint64) {
	chats, err := n.chats.List()
	if err != nil {
		logger.Error("chat: finding chats to name", "err", err.Error())
	}
	if n.describer.Tier() == domain.TierDumb {
		return
	}
	type held struct {
		uuid, name          string
		answered, described int
		settles             time.Time
	}
	settle := n.settings.LoadSettings().Chat.Settle()
	found := make([]held, 0, len(chats))
	for _, chat := range chats {
		_, described := chat.Description()
		found = append(found, held{uuid: chat.UUID(), name: chat.Name(), answered: len(n.answered(chat)),
			described: described, settles: chat.Modified().Add(settle)})
	}
	busy, now := n.busyChats(), n.now()
	n.mu.Lock()
	if !n.running || wake != n.wakes {
		n.mu.Unlock()
		return
	}
	n.stopTimer = nil
	var due []held
	var next time.Time
	for _, chat := range found {
		failed, hasFailed := n.failed[chat.uuid]
		if n.naming[chat.uuid] || chat.answered <= chat.described || (hasFailed && chat.answered <= failed) {
			continue
		}
		if chat.described > 0 {
			if busy[chat.uuid] {
				continue
			}
			if now.Before(chat.settles) {
				if next.IsZero() || chat.settles.Before(next) {
					next = chat.settles
				}
				continue
			}
		}
		n.naming[chat.uuid] = true
		due = append(due, chat)
	}
	if !next.IsZero() {
		n.setTimer(next)
	}
	n.mu.Unlock()
	for _, chat := range due {
		n.submit(chat.uuid, chat.name)
	}
}

// submit submits the job that describes chat uuid, called name, whose naming flag is set.
func (n *ChatNamer) submit(uuid, name string) {
	type described struct {
		d        domain.NoteMetadata
		answered int
		before   string
	}
	n.engine.Submit(services.JobDescriptor{
		Category: block.CategoryAI,
		Meta:     domain.JobInfo{JobID: chatNamingJob + uuid, Label: "Naming " + name, DocID: uuid},
		Work: func() (any, error) {
			chat, err := n.chats.Load(uuid)
			if err != nil {
				return nil, err
			}
			turns := n.answered(chat)
			d, err := n.describer.DescribeChat(uuid, turns)
			if err != nil {
				return nil, failedDescription{answered: len(turns), err: err}
			}
			return described{d: d, answered: len(turns), before: chat.Name()}, nil
		},
		OnFinished: func(result any) {
			r := result.(described)
			saved, err := n.chats.Describe(uuid, r.d, r.answered)
			if err != nil {
				logger.Error("chat: keeping a chat's description", "chat", uuid, "err", err.Error())
				n.finished(uuid, r.answered, false)
				return
			}
			logger.Info("chat: named a chat", "chat", uuid, "answered", r.answered, "title", r.d.Title)
			n.finished(uuid, r.answered, true)
			n.announce(r.before, saved)
		},
		OnError: func(err error) {
			var failed failedDescription
			answered := 0
			if errors.As(err, &failed) {
				answered = failed.answered
			}
			logger.Warn("chat: describing a chat failed", "chat", uuid, "answered", answered, "err", err.Error())
			n.finished(uuid, answered, false)
		},
	})
}

// finished is the job of chat uuid over, its description of answered answered exchanges kept or,
// when !kept, failed. The chat is read again at once, in case it grew while the job ran.
func (n *ChatNamer) finished(uuid string, answered int, kept bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.naming, uuid)
	if kept {
		delete(n.failed, uuid)
	} else {
		n.failed[uuid] = answered
	}
	if n.running {
		n.setTimer(n.now())
	}
}

// announce tells the listener what chat, called before until now, is called now, when that
// changed.
func (n *ChatNamer) announce(before string, chat *domain.Chat) {
	if name := chat.Name(); name != before && n.listener != nil {
		n.listener.ChatNamed(chat.UUID(), name)
	}
}

// answered is chat's answered exchanges, as the describer is shown them.
func (n *ChatNamer) answered(chat *domain.Chat) []string {
	return block.NewChatView(chat.UUID(), chat.Exchanges()).Answered()
}

// busyChats is the chats a job other than the namer's own is queued or running for.
func (n *ChatNamer) busyChats() map[string]bool {
	busy := map[string]bool{}
	if n.jobs == nil {
		return busy
	}
	for _, job := range append(n.jobs.Active(), n.jobs.Queued()...) {
		if job.DocID != "" && !strings.HasPrefix(job.JobID, chatNamingJob) {
			busy[job.DocID] = true
		}
	}
	return busy
}

// setTimer replaces the pending wake with one at at. n.mu is held.
func (n *ChatNamer) setTimer(at time.Time) {
	if n.stopTimer != nil {
		n.stopTimer()
	}
	n.wakes++
	wake := n.wakes
	n.stopTimer = n.afterFunc(max(at.Sub(n.now()), 0), func() { n.wake(wake) })
}

// failedDescription is a description the describer failed to give, of answered answered
// exchanges.
type failedDescription struct {
	answered int
	err      error
}

func (e failedDescription) Error() string { return e.err.Error() }
func (e failedDescription) Unwrap() error { return e.err }
