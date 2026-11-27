package block

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"sieve/ident"
	"sieve/sieve/domain"
)

// answerContentTypePrefix is the clipboard vocabulary's prefix: a kind's content
// type is "sieve/{kind}".
const answerContentTypePrefix = "sieve/"

// AnswerKind is the optional capability of a kind a model may write an answer in.
// A kind that does not implement it is never offered.
//
// AnswerCard describes the kind to the model; its ContentType is left empty, as
// the registry names it. AnswerSource validates the map a model supplied and
// returns what the element is built from; an error refuses the map.
//
// A fresh block InitAttrs builds PENDING lands PENDING and its kind's job is
// dispatched for it as for any block, so it must be one its kind declares a job
// for; a PENDING block with no job would wait for ever.
type AnswerKind interface {
	AnswerCard() domain.AnswerCard
	AnswerSource(attrs AnswerAttrs) (AnswerSource, error)
}

// AnswerSource is what an answer element is built from, in one of two forms.
// Overrides seed the kind's InitAttrs, setting whatever keys the server owns.
// Entries are content the kind's processor builds the block from, as it builds
// the block a paste of that content makes: in the document the answer is in,
// any asset the content denotes acquired and stored there, the overrides its
// Transform returns then seeding InitAttrs. A source carries one or the other.
type AnswerSource struct {
	Overrides map[string]any
	Entries   []ContentEntry
}

// AnswerAttrs is the map a model supplied for one answer element.
type AnswerAttrs map[string]any

// Strings returns the attrs named by keys, each required to be a non-blank
// string, and refuses a map carrying any key not named.
func (a AnswerAttrs) Strings(keys ...string) (map[string]string, error) {
	return a.StringsWith(keys)
}

// StringsWith returns the attrs named by required, each a non-blank string, and
// those of optional the map carries, each a non-blank string when present; it
// refuses a map carrying any key named by neither.
func (a AnswerAttrs) StringsWith(required []string, optional ...string) (map[string]string, error) {
	out := make(map[string]string, len(required)+len(optional))
	for _, k := range required {
		s, _ := a[k].(string)
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("attr %q is required and must be a non-blank string", k)
		}
		out[k] = s
	}
	for _, k := range optional {
		v, present := a[k]
		if !present {
			continue
		}
		s, _ := v.(string)
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("attr %q must be a non-blank string when given", k)
		}
		out[k] = s
	}
	for k := range a {
		if _, named := out[k]; !named {
			return nil, fmt.Errorf("attr %q is not one this content type takes", k)
		}
	}
	return out, nil
}

// AnswerCards returns the card of every registered kind a model may write an
// answer in, in registry order, each named by its content type.
func (r Registry) AnswerCards() []domain.AnswerCard {
	var out []domain.AnswerCard
	for _, p := range r.Ordered() {
		if kind, ok := p.(AnswerKind); ok {
			card := kind.AnswerCard()
			card.ContentType = answerContentTypePrefix + p.Kind()
			out = append(out, card)
		}
	}
	return out
}

// BuildAnswerElement builds one answer element of contentType from the attrs a
// model supplied, through the kind's own processor, with a fresh id, for an
// answer held in document container ("" when it is held in none). An element
// born PENDING is one its kind's job is dispatched for once it lands. An unknown
// or unoffered content type is refused with the whole catalogue; a map the kind
// refuses, content it cannot build a block from, or a map that would build a
// PENDING block its kind declares no job for, is refused with the kind's card.
// Content is built from only for an answer held in a document, and what its
// acquisition stores there stays even when the element is then not written.
func (r Registry) BuildAnswerElement(container, contentType string, attrs map[string]any) (domain.SieveBlock, error) {
	kindName, isSieve := strings.CutPrefix(strings.TrimSpace(contentType), answerContentTypePrefix)
	p := r.Get(kindName)
	kind, offered := p.(AnswerKind)
	if !isSieve || !offered {
		return domain.SieveBlock{}, fmt.Errorf("%q is not a content type an answer can be written in; the content types are: %s",
			contentType, r.cardsJSON(r.AnswerCards()...))
	}
	card := kind.AnswerCard()
	card.ContentType = answerContentTypePrefix + kindName
	source, err := kind.AnswerSource(AnswerAttrs(attrs))
	if err != nil {
		return domain.SieveBlock{}, fmt.Errorf("%s refused: %v; its card: %s", card.ContentType, err, r.cardsJSON(card))
	}
	id := ident.New()
	overrides := source.Overrides
	if source.Entries != nil {
		if overrides, err = r.acquire(p, source.Entries, container, id); err != nil {
			return domain.SieveBlock{}, fmt.Errorf("%s refused: %v; its card: %s", card.ContentType, err, r.cardsJSON(card))
		}
	}
	blk := domain.NewSieveBlock(kindName, id, p.InitAttrs(id, overrides))
	if blk.Status() == BlockStatusPending && p.DescribeJob(JobContext{Ctx: context.Background(), Block: &blk}) == nil {
		return domain.SieveBlock{}, fmt.Errorf("%s refused: this block would wait on work no job does; its card: %s",
			card.ContentType, r.cardsJSON(card))
	}
	return blk, nil
}

// acquire builds the overrides of block id from entries in document container
// through p, as a paste of them builds its block, with the acquisition's own
// error when p reports one.
func (Registry) acquire(p BlockProcessor, entries []ContentEntry, container, id string) (map[string]any, error) {
	if container == "" {
		return nil, fmt.Errorf("this answer is held in no document to keep its content")
	}
	if a, ok := p.(EntryAcquirer); ok {
		return a.Acquire(entries, container, id, ActionPaste)
	}
	if overrides := p.Transform(entries, container, id, ActionPaste); overrides != nil {
		return overrides, nil
	}
	return nil, fmt.Errorf("its content could not be made into a block")
}

// Waits reports whether el, an element BuildAnswerElement built, lands waiting
// on work its kind's job does.
func (Registry) Waits(el domain.SieveBlock) bool {
	return el.Status() == BlockStatusPending
}

// cardsJSON renders cards as the JSON a refusal carries.
func (Registry) cardsJSON(cards ...domain.AnswerCard) string {
	out, err := json.Marshal(cards)
	if err != nil {
		return "[]"
	}
	return string(out)
}
