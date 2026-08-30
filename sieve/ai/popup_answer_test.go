package ai

import "testing"

// popupAnswerOf returns the single prose span a completed popup block's answer
// holds, failing the test when the block does not carry exactly that.
//
// It reads the answer THE WAY THE BLOCK MODEL DOES — down the list, into the
// entry's attrs bag — so a popup block's answer is asserted against the shape
// every other answer has, not against a spelling this package chose.
func popupAnswerOf(t *testing.T, attrs map[string]interface{}) string {
	t.Helper()
	if _, retired := attrs["response"]; retired {
		t.Fatalf("a popup block carries the retired `response` attr: %+v", attrs)
	}
	list, ok := attrs["answer"].([]interface{})
	if !ok || len(list) != 1 {
		t.Fatalf("answer is not a one-element list: %+v", attrs["answer"])
	}
	entry, ok := list[0].(map[string]interface{})
	if !ok || entry["kind"] != "prose" {
		t.Fatalf("answer element is not a prose block: %+v", list[0])
	}
	elAttrs, ok := entry["attrs"].(map[string]interface{})
	if !ok {
		t.Fatalf("answer element carries no attrs bag: %+v", entry)
	}
	content, _ := elAttrs["content"].(string)
	return content
}

// The completion is the envelope plus the answer, and the envelope it was built
// from is left alone: the client is already rendering that map.
func TestPopupAnswer_CompletesWithoutDisturbingThePendingEnvelope(t *testing.T) {
	pending := map[string]interface{}{"status": "PENDING", "type": "BTW", "question": "why?"}

	done := popupAnswer{}.complete(pending, "because")

	if done.Kind != "ai-block" {
		t.Errorf("kind = %q, want ai-block", done.Kind)
	}
	if done.Attrs["status"] != "COMPLETE" || done.Attrs["completedAt"] == "" {
		t.Errorf("completion envelope = %+v", done.Attrs)
	}
	if done.Attrs["type"] != "BTW" || done.Attrs["question"] != "why?" {
		t.Errorf("the pending envelope did not carry through: %+v", done.Attrs)
	}
	if got := popupAnswerOf(t, done.Attrs); got != "because" {
		t.Errorf("answer content = %q", got)
	}
	if pending["status"] != "PENDING" || len(pending) != 3 {
		t.Errorf("the pending envelope was written to: %+v", pending)
	}
}
