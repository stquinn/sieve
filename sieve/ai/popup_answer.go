package ai

import (
	"fmt"
	"time"

	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// popupAnswer is the one path a popup AI command answers by: it announces the
// command's ai-block PENDING, runs the model with its MCP grant bound to that
// block (the command's Exchange), and completes the block with the answer. A
// command embedding it supplies only its question, its prompt and its label.
//
// AN ANSWER IS A LIST OF BLOCKS, on this side of the wall as on the other. A
// model may write it block by block into the command's block (add_to_answer),
// which the command plane holds; one that did not produces one span of prose,
// written as the one-element list that span is, in the element encoding every
// ai-block slot uses — a `kind` and an `attrs` bag per entry. Element ids are
// minted where a list enters the block model; a popup block enters no document
// and needs none.
//
// The keys are spelled here rather than imported because `ai` sits BELOW
// `block` in the package DAG: block.AnswerAttr, block.KindProse and the element
// encoding are what these literals must equal, and popup_answer_ext_test.go
// decodes this output through the real block-side reader to hold them to it.
type popupAnswer struct {
	ai *AIService
	docMetaReader
}

func newPopupAnswer(aiSvc *AIService, docs *services.DocumentService) popupAnswer {
	return popupAnswer{ai: aiSvc, docMetaReader: docMetaReader{docs: docs}}
}

// available is a popup AI command's precondition: an AI CLI to answer with.
func (p popupAnswer) available() error {
	if p.ai == nil || p.ai.Tier() == domain.TierDumb {
		return fmt.Errorf("AI commands are unavailable — configure an AI CLI in Settings")
	}
	return nil
}

// job is the command's job: the PENDING ai-block of type typ asking question
// (its attr value), with what the turn was given recorded on it from then on,
// and Work answering prompt over the document ctx names. The block's id is the
// dispatcher's to stamp, so it carries none here.
func (p popupAnswer) job(label, typ string, question interface{}, prompt string, ctx command.Context) command.Job {
	attrs := map[string]interface{}{
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  question,
		"type":      typ,
		"ref":       "", // detached: no target graph
	}
	// What the turn was given renders the chip row (in the document and in the
	// popup, which hosts the same renderer) and is what a later read shows.
	ctx.Attachments.StampAttrs(attrs)
	return command.Job{
		Label:   label,
		Pending: &command.Block{Kind: "ai-block", Attrs: attrs},
		Work: func() (command.Block, error) {
			title, summary := p.docMeta(ctx.DocUUID)
			answer, err := p.ai.RunBtw(ctx.Attachments.AppendTo(prompt), ctx.SelectedText, title, summary, ctx.Exchange)
			if err != nil {
				return command.Block{}, err
			}
			return p.complete(attrs, answer), nil
		},
	}
}

// complete returns the COMPLETE block: pending's attrs, the answer, and the
// moment it landed. An answer the model wrote into the command's block is that
// block's answer, which the command plane holds, so the final message is
// discarded and the completion carries none of its own. pending is never
// mutated — it is the envelope the client is already rendering.
func (popupAnswer) complete(pending map[string]interface{}, answer Answer) command.Block {
	done := make(map[string]interface{}, len(pending)+3)
	for k, v := range pending {
		done[k] = v
	}
	done["status"] = "COMPLETE"
	if !answer.Written {
		done["answer"] = []interface{}{
			map[string]interface{}{
				"kind":  "prose",
				"attrs": map[string]interface{}{"content": answer.Text},
			},
		}
	}
	done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	return command.Block{Kind: "ai-block", Attrs: done}
}
