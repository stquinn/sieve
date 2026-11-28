package domain

import (
	"fmt"
	"strings"
)

// Exchange names what one run may write: the container its side effects land
// in, and the ai-block whose answer it writes. A run's MCP grant is bound to
// one, and a model writing its answer through the Sieve MCP writes into that
// block and no other.
//
// The block lives in one of two holders, which Holder names: a block of the
// open container Container, or the block of a running command, whose id is that
// command's correlation id. Container names the document a command was run
// over, when there is one, and holds nothing of its answer. An Exchange with no
// Block grants the container alone and answers nothing.
type Exchange struct {
	Container string
	Block     string
	Holder    AnswerHolder
}

// AnswerHolder names what holds an exchange's block.
type AnswerHolder string

const (
	// HeldInContainer is the zero holder: the block is a block of the exchange's
	// Container, held open and written by the editor.
	HeldInContainer AnswerHolder = ""
	// HeldByCommand is the block of the running command whose correlation id is
	// the exchange's Block.
	HeldByCommand AnswerHolder = "command"
)

// Answers reports whether the exchange names a block whose answer can be written.
func (e Exchange) Answers() bool {
	return e.Block != "" && (e.Holder == HeldByCommand || e.Container != "")
}

// AnswerContainer is the container the exchange's answer is held in: its
// Container when that holds the block, "" when a command holds it.
func (e Exchange) AnswerContainer() string {
	if e.Holder != HeldInContainer {
		return ""
	}
	return e.Container
}

// AnswerCard is what a model is told about one content type it may write an
// answer in: the type, when to reach for it, the attrs its map is composed of
// (name → what it holds), and a minimal example map that builds.
//
// Waits names, in plain words, which blocks of the type land waiting on work a
// job does after they land ("every log", "a PlantUML diagram"), "" when none
// do; WaitsAlways says it is every block of the type.
type AnswerCard struct {
	ContentType string            `json:"content_type"`
	Use         string            `json:"use"`
	Attrs       map[string]string `json:"attrs"`
	Example     map[string]any    `json:"example"`
	Waits       string            `json:"waits_on_work,omitempty"`
	WaitsAlways bool              `json:"-"`
}

// AnswerHolding is what an answer's holder can take: whether it runs the job a
// block lands waiting on and keeps what that job makes, and, when it does not,
// why, in words a model is shown. It is THE rule deciding which content types a
// run may write: each holder's writer declares its holding.
type AnswerHolding struct {
	RunsJobs bool
	NoJobs   string // why the holder runs no jobs; read only when RunsJobs is false
}

// Admit decides whether a block of card's type can be written into an answer
// held so; waits says whether the block lands waiting on work. available names
// the content types this answer takes, for the refusal.
func (h AnswerHolding) Admit(card AnswerCard, waits bool, available []string) error {
	if !waits || h.RunsJobs {
		return nil
	}
	what := card.Waits
	if what == "" {
		what = "this block"
	}
	return fmt.Errorf("%s cannot be used in this answer: %s is worked on after it lands, and %s. Available here: %s",
		card.ContentType, what, h.NoJobs, strings.Join(available, ", "))
}

// Offers returns the cards an answer held so takes: every card but those whose
// every block waits on work it does not run.
func (h AnswerHolding) Offers(cards []AnswerCard) []AnswerCard {
	var out []AnswerCard
	for _, card := range cards {
		if h.RunsJobs || !card.WaitsAlways {
			out = append(out, card)
		}
	}
	return out
}

// Note is what a model is told of an answer held so beyond its cards: "" when
// the holder takes every block its cards describe.
func (h AnswerHolding) Note() string {
	if h.RunsJobs {
		return ""
	}
	return "In this answer " + h.NoJobs + ": a block a card says waits on work after it lands is refused."
}
