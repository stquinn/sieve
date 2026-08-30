package command

import (
	"testing"

	"sieve/sieve/domain"
)

// Attachments are COMPOSER-authored: they ride the command envelope and land on
// Context beside the lens-authored fields. A command that wants them reads
// ctx.Attachments in Build — no Build signature changed to make that possible.
func TestContext_CarriesEnvelopeAttachments(t *testing.T) {
	ctx := NewContext([]byte(`{"docUuid":"u1","selectedText":"sel"}`), []domain.Attachment{
		{URI: "sieve://9f2b", Title: "Auth Design"},
		{URI: "sieve://7a1c", Title: "Retry RFC"},
	}, nil)

	// The lens half is untouched.
	if ctx.DocUUID != "u1" || ctx.SelectedText != "sel" {
		t.Fatalf("lens context lost: %+v", ctx)
	}
	if len(ctx.Attachments) != 2 {
		t.Fatalf("attachments = %+v, want 2", ctx.Attachments)
	}
	if ctx.Attachments[0].URI != "sieve://9f2b" || ctx.Attachments[0].Title != "Auth Design" {
		t.Errorf("attachment[0] = %+v", ctx.Attachments[0])
	}
}

// The context JSON is LENS territory. An attachments key smuggled into it is not
// a composer attachment and must never be read as one — the only door is the
// envelope field.
func TestContext_IgnoresAttachmentsInTheContextJSON(t *testing.T) {
	ctx := NewContext([]byte(`{"docUuid":"u1","attachments":[{"uri":"sieve://forged","title":"Forged"}]}`), nil, nil)
	if len(ctx.Attachments) != 0 {
		t.Fatalf("context JSON forged an attachment: %+v", ctx.Attachments)
	}
}

// An address-less entry is not an attachment; a padded one is normalised. The
// same door the block attr path uses (domain.Attachment.Normalised).
func TestContext_DropsAddresslessAttachments(t *testing.T) {
	ctx := NewContext(nil, []domain.Attachment{
		{Title: "no address"},
		{URI: "  sieve://9f2b  ", Title: "  Auth Design  "},
		{URI: "   "},
	}, nil)
	if len(ctx.Attachments) != 1 {
		t.Fatalf("attachments = %+v, want just the addressable one", ctx.Attachments)
	}
	if ctx.Attachments[0].URI != "sieve://9f2b" || ctx.Attachments[0].Title != "Auth Design" {
		t.Errorf("attachment = %+v, want trimmed", ctx.Attachments[0])
	}
}

// PLUMBING ONLY: a command reaches Build with whatever the envelope carried,
// and a command that ignores attachments behaves exactly as it did before the
// field existed.
func TestDispatch_ThreadsAttachmentsToBuild(t *testing.T) {
	r := testRegistry(t)
	var seen []domain.Attachment
	r.Register(&fakeCommand{name: "reader", build: func(text string, ctx Context) (Job, error) {
		seen = ctx.Attachments
		return Job{Label: "/reader", Pending: &Block{Kind: "ai-block"}, Work: func() (Block, error) {
			return Block{Kind: "ai-block"}, nil
		}}, nil
	}})

	emit, ch := collector()
	r.Dispatch("reader", "", "hi", NewContext(nil, []domain.Attachment{
		{URI: "sieve://9f2b", Title: "Auth Design"},
	}, nil), "c-att", emit)
	<-ch // PENDING
	<-ch // COMPLETE

	if len(seen) != 1 || seen[0].URI != "sieve://9f2b" {
		t.Fatalf("Build saw attachments = %+v", seen)
	}
}

func TestDispatch_CommandIgnoringAttachmentsIsUnchanged(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "echo", build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/echo",
			Pending: &Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING"}},
			Work: func() (Block, error) {
				return Block{Kind: "ai-block", Attrs: map[string]interface{}{"response": text}}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("echo", "", "hi", NewContext(nil, []domain.Attachment{{URI: "sieve://9f2b"}}, nil), "c-1", emit)

	if first := <-ch; first.Status != StatusPending {
		t.Fatalf("want PENDING, got %+v", first)
	}
	second := <-ch
	if second.Status != StatusComplete || second.Block.Attrs["response"] != "hi" {
		t.Fatalf("attachments changed an indifferent command's outcome: %+v", second)
	}
}
