package editor

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/clocktest"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// fakeChatDescriber answers every description with answer, or err, at tier, and keeps the turns
// it was shown. While hold is set each description waits for it to close.
type fakeChatDescriber struct {
	mu     sync.Mutex
	tier   domain.Tier
	answer domain.NoteMetadata
	err    error
	hold   chan struct{}
	shown  [][]string
}

func (d *fakeChatDescriber) Tier() domain.Tier {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.tier
}

func (d *fakeChatDescriber) DescribeChat(_ string, turns []string) (domain.NoteMetadata, error) {
	d.mu.Lock()
	d.shown = append(d.shown, turns)
	hold, answer, err := d.hold, d.answer, d.err
	d.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return answer, err
}

func (d *fakeChatDescriber) calls() [][]string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.shown)
}

func (d *fakeChatDescriber) set(change func(*fakeChatDescriber)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	change(d)
}

// parserChat is what the fake describer says of a chat.
var parserChat = domain.NoteMetadata{Title: "Parser error taxonomy", Keywords: []string{"parser", "errors"},
	Categories: []string{"Work"}, Summary: "Kinds of parse error. Which is worst.", CLI: "agy"}

// chatSettle is the settle time the rig's namer runs with.
const chatSettle = 10 * time.Second

// chatNamerRig is one chat named by a namer on a fake clock, with a settle time of chatSettle, a
// fake describer, the real job engine and tracker, and the editor's recordingSaves hearing the
// chat's new names. The chat holds the exchanges the rig was given, last changed at the clock's
// start.
type chatNamerRig struct {
	t         *testing.T
	chats     *services.ChatService
	st        *filestore.FileStore
	clock     *clocktest.Clock
	describer *fakeChatDescriber
	tracker   *services.JobTracker
	engine    *services.JobEngine
	saves     *recordingSaves
	namer     *ChatNamer
	uuid      string
}

func newChatNamerRig(t *testing.T, exchanges ...domain.SieveBlock) *chatNamerRig {
	t.Helper()
	resetRegistry()
	t.Cleanup(resetRegistry)
	chats, _, _, st := newTestChats(t)
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{}))
	rig := &chatNamerRig{t: t, chats: chats, st: st, clock: clocktest.New(), saves: newRecordingSaves(),
		describer: &fakeChatDescriber{tier: domain.TierSmart, answer: parserChat}, tracker: services.NewJobTracker()}
	rig.engine = services.NewJobEngine(nil, 2, rig.tracker)
	c, err := chats.Create("")
	if err != nil {
		t.Fatal(err)
	}
	rig.uuid = c.UUID()
	rig.grow(exchanges...)
	rig.namer = rig.newNamer()
	return rig
}

// newNamer is a namer over the rig, started, as a Sieve starting again builds it.
func (rig *chatNamerRig) newNamer() *ChatNamer {
	state, err := services.NewStateService(rig.st, "", nil)
	if err != nil {
		rig.t.Fatal(err)
	}
	settings := state.LoadSettings()
	settings.Chat.SettleSeconds = int(chatSettle / time.Second)
	if err := state.SaveSettings(settings); err != nil {
		rig.t.Fatal(err)
	}
	n := NewChatNamer(rig.chats, rig.describer, rig.engine, rig.tracker, state, rig.saves)
	n.now, n.afterFunc = rig.clock.Now, rig.clock.AfterFunc
	n.Start()
	rig.t.Cleanup(n.Stop)
	return n
}

// grow appends exchanges to the chat and saves it, the chat then last changed at the clock's
// time, as an exchange asked and answered leaves it.
func (rig *chatNamerRig) grow(exchanges ...domain.SieveBlock) {
	rig.t.Helper()
	c, err := rig.chats.Load(rig.uuid)
	if err != nil {
		rig.t.Fatal(err)
	}
	c.SetExchanges(append(c.Exchanges(), exchanges...))
	if _, err := rig.chats.Save(c); err != nil {
		rig.t.Fatal(err)
	}
	rig.changedAt(rig.clock.Now())
}

// answered grows the chat by exchanges and tells the namer a job of it ended, as the editor does.
func (rig *chatNamerRig) answered(exchanges ...domain.SieveBlock) {
	rig.t.Helper()
	rig.grow(exchanges...)
	rig.namer.ChatAnswered(rig.uuid)
}

// changedAt makes the chat's .meta say it was last changed at at.
func (rig *chatNamerRig) changedAt(at time.Time) {
	rig.t.Helper()
	if _, err := rig.chats.SaveMeta(rig.uuid, func(m domain.DocumentMeta) {
		m.All()["modified"] = at.Local().Format("2006-01-02T15:04:05")
	}); err != nil {
		rig.t.Fatal(err)
	}
}

// settled advances the clock by d and waits until no naming job is queued or running.
func (rig *chatNamerRig) settled(d time.Duration) {
	rig.t.Helper()
	rig.clock.Advance(d)
	clocktest.WaitFor(rig.t, func() bool {
		rig.namer.mu.Lock()
		defer rig.namer.mu.Unlock()
		return len(rig.namer.naming) == 0 && len(rig.tracker.Active())+len(rig.tracker.Queued()) == 0
	})
}

// chat is the chat as the store holds it now.
func (rig *chatNamerRig) chat() *domain.Chat {
	rig.t.Helper()
	c, err := rig.chats.Load(rig.uuid)
	if err != nil {
		rig.t.Fatal(err)
	}
	return c
}

// named checks what the chat is called, what its description summarises and how many answered
// exchanges it was of.
func (rig *chatNamerRig) named(name, summary string, answered int) {
	rig.t.Helper()
	c := rig.chat()
	d, of := c.Description()
	if c.Name() != name || d.Summary != summary || of != answered {
		rig.t.Errorf("named %q, summary %q, of %d answered; want %q, %q, %d", c.Name(), d.Summary, of, name, summary, answered)
	}
}

// snapshots is how many snapshots the chat's history holds.
func (rig *chatNamerRig) snapshots() int {
	dir, _ := rig.st.DocDirByUUID(rig.uuid)
	entries, _ := os.ReadDir(filepath.Join(dir, ".history"))
	return len(entries)
}

// A chat is described once its first exchange is answered, without waiting to settle: one job,
// shown each answered exchange's question and answer and no address, whose description is kept
// in the chat's .meta, its version and its history unmoved, and whose new name is announced. An
// unanswered exchange is not shown, and a chat that has not grown is not described again.
func TestChatNamer_DescribesAChatOnceItsFirstExchangeIsAnswered(t *testing.T) {
	rig := newChatNamerRig(t)
	rig.settled(time.Hour)
	if calls := rig.describer.calls(); len(calls) != 0 {
		t.Fatalf("an empty chat was described %d times", len(calls))
	}
	pending := domain.NewSieveBlock(block.KindAIBlock, "", map[string]interface{}{"status": block.BlockStatusPending})
	rig.answered(answeredExchange("What errors can a parser raise?", "Three kinds."), pending)
	version, history := rig.chat().Version(), rig.snapshots()
	rig.settled(0)

	calls := rig.describer.calls()
	if len(calls) != 1 || len(calls[0]) != 1 {
		t.Fatalf("described %v, want once, shown the one answered exchange", calls)
	}
	if turn := calls[0][0]; !strings.Contains(turn, "What errors can a parser raise?") || !strings.Contains(turn, "Three kinds.") || strings.Contains(turn, "ADDRESS") || strings.Contains(turn, "sieve://") {
		t.Errorf("shown the turn %q", turn)
	}
	rig.named(parserChat.Title, parserChat.Summary, 1)
	if c := rig.chat(); c.Version() != version || rig.snapshots() != history {
		t.Errorf("the description moved the chat to version %d with %d snapshots, from %d with %d", c.Version(), rig.snapshots(), version, history)
	}
	if got, want := rig.saves.namings(), []string{rig.uuid + " " + parserChat.Title}; !slices.Equal(got, want) {
		t.Errorf("announced %v, want %v", got, want)
	}
	if cli, at := rig.chat().DescribedBy(); cli != parserChat.CLI {
		t.Errorf("described by CLI %q, want %q", cli, parserChat.CLI)
	} else if _, err := time.Parse(domain.MetaAiTimeLayout, at); err != nil {
		t.Errorf("described at %q: %v", at, err)
	}

	rig.namer.ChatAnswered(rig.uuid)
	rig.settled(time.Hour)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Errorf("a chat that has not grown was described %d times", len(calls))
	}
}

// A described chat that grows is described again once it settles: no question asked and no job of
// it running for the settle time since it last changed. One that settles without having grown is
// not.
func TestChatNamer_AChatThatGrowsIsDescribedAgainOnceItSettles(t *testing.T) {
	rig := newChatNamerRig(t, answeredExchange("What errors can a parser raise?", "Three kinds."))
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("described %d times at start, want once", len(calls))
	}

	rig.describer.set(func(d *fakeChatDescriber) {
		d.answer = domain.NoteMetadata{Title: "Parser errors, ranked", Summary: "Ranked."}
	})
	rig.answered(answeredExchange("Which is worst?", "The silent one."))
	rig.settled(chatSettle - time.Second)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("described %d times before the chat settled", len(calls))
	}
	rig.settled(time.Second)
	if calls := rig.describer.calls(); len(calls) != 2 || len(calls[1]) != 2 {
		t.Fatalf("described %v once the chat settled, want again, shown both exchanges", calls)
	}
	rig.named("Parser errors, ranked", "Ranked.", 2)

	rig.namer.ChatAnswered(rig.uuid)
	rig.settled(time.Hour)
	if calls := rig.describer.calls(); len(calls) != 2 {
		t.Errorf("a chat that settled without growing was described %d times, want 2", len(calls))
	}
}

// A question asked, or a job of the chat running, keeps it from settling: it settles the settle
// time after it last changed, and not while a job of it is queued or running, the namer's own
// aside.
func TestChatNamer_AnAskOrARunningJobKeepsAChatFromSettling(t *testing.T) {
	rig := newChatNamerRig(t, answeredExchange("One?", "One."))
	rig.settled(0)
	rig.answered(answeredExchange("Two?", "Two."))
	rig.settled(chatSettle / 2)
	rig.changedAt(rig.clock.Now())
	rig.settled(chatSettle - time.Second)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("described %d times before the chat settled from its last change", len(calls))
	}

	job := domain.JobInfo{JobID: ident.New(), DocID: rig.uuid}
	rig.tracker.Enqueue(job)
	rig.clock.Advance(time.Hour)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("described %d times while a job of the chat was queued", len(calls))
	}
	rig.tracker.Finish(job.JobID)
	rig.namer.ChatAnswered(rig.uuid)
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 2 {
		t.Errorf("described %d times once the job ended, want 2", len(calls))
	}
}

// A grown chat found when the namer starts settles the settle time after it last changed, so one
// quiet for longer is described at once and one changed just before waits only the rest.
func TestChatNamer_SettlesFromWhenTheChatLastChangedAcrossARestart(t *testing.T) {
	for _, tc := range []struct {
		name    string
		changed time.Duration
		// wait is how long after the new namer starts the chat is described.
		wait time.Duration
	}{
		{"quiet for an hour", -time.Hour, 0},
		{"changed four seconds before", -4 * time.Second, chatSettle - 4*time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newChatNamerRig(t, answeredExchange("One?", "One."))
			rig.settled(0)
			rig.namer.Stop()
			rig.grow(answeredExchange("Two?", "Two."))
			rig.changedAt(rig.clock.Now().Add(tc.changed))
			rig.namer = rig.newNamer()
			if tc.wait > 0 {
				rig.settled(tc.wait - time.Second)
				if calls := rig.describer.calls(); len(calls) != 1 {
					t.Fatalf("described %d times before the chat settled", len(calls))
				}
				rig.settled(time.Second)
			} else {
				rig.settled(0)
			}
			if calls := rig.describer.calls(); len(calls) != 2 {
				t.Errorf("described %d times once settled, want 2", len(calls))
			}
		})
	}
}

// A name given by hand is kept by every later description, which describes the rest; a blank one
// hands naming back, and the chat is described at once and named by its description.
func TestChatNamer_KeepsANameGivenByHandUntilItIsCleared(t *testing.T) {
	rig := newChatNamerRig(t, answeredExchange("What errors can a parser raise?", "Three kinds."))
	rig.settled(0)
	if err := rig.namer.Rename(rig.uuid, "  Mine  "); err != nil {
		t.Fatal(err)
	}
	rig.named("Mine", parserChat.Summary, 1)

	rig.describer.set(func(d *fakeChatDescriber) {
		d.answer = domain.NoteMetadata{Title: "Parser errors, ranked", Summary: "Ranked."}
	})
	rig.answered(answeredExchange("Which is worst?", "The silent one."))
	rig.settled(chatSettle)
	rig.named("Mine", "Ranked.", 2)

	if err := rig.namer.Rename(rig.uuid, ""); err != nil {
		t.Fatal(err)
	}
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 3 {
		t.Errorf("described %d times, want again once the name was cleared", len(calls))
	}
	rig.named("Parser errors, ranked", "Ranked.", 2)
	want := []string{rig.uuid + " " + parserChat.Title, rig.uuid + " Mine", rig.uuid + " What errors can a parser raise?", rig.uuid + " Parser errors, ranked"}
	if got := rig.saves.namings(); !slices.Equal(got, want) {
		t.Errorf("announced %v, want %v", got, want)
	}
	if err := rig.namer.Rename(ident.New(), "x"); !errors.Is(err, domain.ErrNotChat) {
		t.Errorf("renaming no chat: %v, want ErrNotChat", err)
	}
}

// NameNow describes a chat at once, grown or not, and does nothing while its job runs.
func TestChatNamer_NameNowDescribesAChatAtOnce(t *testing.T) {
	rig := newChatNamerRig(t, answeredExchange("One?", "One."))
	rig.settled(0)
	rig.describer.set(func(d *fakeChatDescriber) { d.answer = domain.NoteMetadata{Title: "Asked again", Summary: "Again."} })
	if err := rig.namer.NameNow(rig.uuid); err != nil {
		t.Fatal(err)
	}
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 2 {
		t.Fatalf("described %d times, want again at once", len(calls))
	}
	rig.named("Asked again", "Again.", 1)

	hold := make(chan struct{})
	rig.describer.set(func(d *fakeChatDescriber) { d.hold = hold })
	if err := rig.namer.NameNow(rig.uuid); err != nil {
		t.Fatal(err)
	}
	clocktest.WaitFor(t, func() bool { return len(rig.describer.calls()) == 3 })
	if err := rig.namer.NameNow(rig.uuid); err != nil {
		t.Fatal(err)
	}
	close(hold)
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 3 {
		t.Errorf("asked again while its job ran: %d descriptions, want 3", len(calls))
	}
}

// NameNow refuses a chat it cannot name now, submitting nothing, and Refusal says why in words.
func TestChatNamer_NameNowRefusesWhatItCannotName(t *testing.T) {
	for _, tc := range []struct {
		name      string
		exchanges []domain.SieveBlock
		block     func(*chatNamerRig)
		uuid      string
		want      error
		says      string
	}{
		{"a dumb tier", []domain.SieveBlock{answeredExchange("One?", "One.")},
			func(rig *chatNamerRig) { rig.describer.set(func(d *fakeChatDescriber) { d.tier = domain.TierDumb }) }, "", ErrChatNamingUnavailable, "No AI is configured"},
		{"no answer yet", nil, func(*chatNamerRig) {}, "", ErrNothingToName, "no answer"},
		{"not a chat", nil, func(*chatNamerRig) {}, ident.New(), domain.ErrNotChat, "not a chat"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newChatNamerRig(t)
			tc.block(rig)
			rig.grow(tc.exchanges...)
			uuid := rig.uuid
			if tc.uuid != "" {
				uuid = tc.uuid
			}
			err := rig.namer.NameNow(uuid)
			if !errors.Is(err, tc.want) {
				t.Fatalf("NameNow = %v, want %v", err, tc.want)
			}
			if says := rig.namer.Refusal(err); !strings.Contains(says, tc.says) {
				t.Errorf("Refusal = %q, want it to say %q", says, tc.says)
			}
			rig.settled(time.Hour)
			if calls := rig.describer.calls(); len(calls) != 0 {
				t.Errorf("described %d times", len(calls))
			}
		})
	}
}

// A description that fails leaves the chat undescribed, and it is not asked for again until the
// chat grows.
func TestChatNamer_AFailedDescriptionWaitsForTheChatToGrow(t *testing.T) {
	rig := newChatNamerRig(t)
	rig.describer.set(func(d *fakeChatDescriber) { d.err = errors.New("the model said nothing") })
	rig.answered(answeredExchange("One?", "One."))
	rig.settled(0)
	rig.namer.ChatAnswered(rig.uuid)
	rig.settled(time.Hour)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("a failed description was asked for %d times", len(calls))
	}
	rig.named("One?", "", 0)

	rig.describer.set(func(d *fakeChatDescriber) { d.err = nil })
	rig.answered(answeredExchange("Two?", "Two."))
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 2 {
		t.Errorf("described %d times after the chat grew, want 2", len(calls))
	}
	rig.named(parserChat.Title, parserChat.Summary, 2)
}

// The job is named for the chat and shown where jobs are while it runs.
func TestChatNamer_TheJobIsLabelledWithTheChat(t *testing.T) {
	rig := newChatNamerRig(t)
	hold := make(chan struct{})
	rig.describer.set(func(d *fakeChatDescriber) { d.hold = hold })
	rig.answered(answeredExchange("What errors can a parser raise?", "Three kinds."))
	rig.clock.Advance(0)
	clocktest.WaitFor(t, func() bool { return len(rig.tracker.Active()) == 1 })
	job := rig.tracker.Active()[0]
	if job.JobID != chatNamingJob+rig.uuid || job.Label != "Naming What errors can a parser raise?" || job.DocID != rig.uuid || job.Category != block.CategoryAI {
		t.Errorf("the job is %+v", job)
	}
	close(hold)
	rig.settled(0)
}
