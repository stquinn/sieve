package ai

import (
	"time"

	"sieve/sieve/command"
)

// popupAnswer completes a popup command's ai-block: the PENDING envelope it was
// announced with, plus the answer the CLI produced.
//
// AN ANSWER IS A LIST OF BLOCKS, on this side of the wall as on the other. A
// popup command produces one span of prose, so it writes the one-element list
// that span is, in the element encoding every ai-block slot uses — a `kind` and
// an `attrs` bag per entry. Element ids are minted where a list enters the block
// model; a popup block enters no document and needs none.
//
// The keys are spelled here rather than imported because `ai` sits BELOW
// `block` in the package DAG: block.AnswerAttr, block.KindProse and the element
// encoding are what these literals must equal, and popup_answer_ext_test.go
// decodes this output through the real block-side reader to hold them to it.
type popupAnswer struct{}

// complete returns the COMPLETE block: pending's attrs, the answer, and the
// moment it landed. pending is never mutated — it is the envelope the client is
// already rendering.
func (popupAnswer) complete(pending map[string]interface{}, answer string) command.Block {
	done := make(map[string]interface{}, len(pending)+3)
	for k, v := range pending {
		done[k] = v
	}
	done["status"] = "COMPLETE"
	done["answer"] = []interface{}{
		map[string]interface{}{
			"kind":  "prose",
			"attrs": map[string]interface{}{"content": answer},
		},
	}
	done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	return command.Block{Kind: "ai-block", Attrs: done}
}
