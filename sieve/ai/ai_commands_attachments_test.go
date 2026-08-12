package ai

import (
	"encoding/json"
	"strings"
	"testing"

	"sieve/sieve/command"
	"sieve/sieve/domain"
)

// The AI family is treated UNIFORMLY: /btw, /summary and /todo all send their
// question through the same backend, so all three consume a turn's attachments
// the same way. Every assertion below runs against the whole family rather than
// pinning /btw and hoping.
type aiFamilyCase struct {
	name string
	text string
	make func(*AIService) command.Command
}

func aiFamily() []aiFamilyCase {
	return []aiFamilyCase{
		{"btw", "how do tokens rotate?", func(s *AIService) command.Command { return NewBtwCommand(s, nil) }},
		{"summary", "", func(s *AIService) command.Command { return NewSummaryCommand(s, nil) }},
		{"todo", "", func(s *AIService) command.Command { return NewTodoCommand(s, nil) }},
	}
}

const (
	authURI  = "container:aaaaaaaa-1a2b-4c5d-8e9f-a1b2c3d4e5f6"
	retryURI = "container:bbbbbbbb-1a2b-4c5d-8e9f-a1b2c3d4e5f6"
)

// attachedPair is what the composer sends and the envelope carries: addresses
// and the titles they were attached under. Nothing more is needed to render the
// manifest, and nothing more is ever fetched.
func attachedPair() []domain.Attachment {
	return []domain.Attachment{
		{URI: authURI, Title: "Auth Design"},
		{URI: retryURI, Title: "Retry RFC"},
	}
}

// runFamilyCommand builds and runs one command to completion against a stubbed
// runner (CI has no AI CLI to exec), returning the pending attrs, the completed
// attrs and the prompt the backend was handed.
func runFamilyCommand(t *testing.T, c command.Command, text string, ctx command.Context, cap *captureRunner) (pending, done map[string]interface{}, prompt string) {
	t.Helper()
	job, err := c.Build(text, ctx)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	blk, err := job.Work()
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	return job.Pending.Attrs, blk.Attrs, cap.prompt
}

// familyManifestEntries pulls the JSON array out of the section a command
// rendered, so assertions are about the DATA rather than surrounding whitespace.
func familyManifestEntries(t *testing.T, prompt string) []map[string]any {
	t.Helper()
	at := strings.Index(prompt, "ATTACHED DOCUMENTS")
	if at < 0 {
		t.Fatalf("prompt carries no attachments section:\n%s", prompt)
	}
	section := prompt[at:]
	open := strings.Index(section, "[")
	closing := strings.Index(section, "\n]")
	if open < 0 || closing < open {
		t.Fatalf("section carries no JSON array:\n%s", section)
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(section[open:closing+2]), &entries); err != nil {
		t.Fatalf("section JSON is not parseable (%v):\n%s", err, section)
	}
	return entries
}

// THE gap this closes: attachments rode the envelope and did nothing. Every
// AI-family command now renders ONE ATTACHED DOCUMENTS section naming this
// turn's documents by the coordinate get_by_uri takes — the same string the
// block persisted, so nothing anywhere translates.
//
// There is ONE renderer (domain.Attachments.PromptSection), asserted at the
// renderer in domain and HERE through a real command, so the ai-block path and
// the command path cannot drift into two wordings.
func TestAIFamily_RendersOneManifestSectionForItsAttachments(t *testing.T) {
	for _, tc := range aiFamily() {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: "answer"}
			svc := newSmartTestService(t, cap)

			_, _, prompt := runFamilyCommand(t, tc.make(svc), tc.text,
				command.NewContext(nil, attachedPair()), cap)

			if n := strings.Count(prompt, "ATTACHED DOCUMENTS"); n != 1 {
				t.Fatalf("rendered %d sections, want exactly 1:\n%s", n, prompt)
			}
			if !strings.Contains(prompt, "get_by_uri") {
				t.Errorf("the manifest must name the retrieval verb:\n%s", prompt)
			}

			// Attachments are a property of the QUESTION, so the section sits with
			// it — the same seam and the same order the ai-block path renders
			// (question, then its attached documents).
			if tc.text != "" && !strings.Contains(prompt, tc.text+"\n\nATTACHED DOCUMENTS") {
				t.Errorf("the section must follow the question it belongs to:\n%s", prompt)
			}

			entries := familyManifestEntries(t, prompt)
			if len(entries) != 2 {
				t.Fatalf("entries = %+v, want both attachments", entries)
			}
			// The entry's uri is the persisted coordinate, byte-for-byte — the
			// same string the result block stores and the model passes back.
			if entries[0]["title"] != "Auth Design" || entries[0]["uri"] != authURI {
				t.Errorf("entry[0] = %+v", entries[0])
			}
			if entries[1]["title"] != "Retry RFC" || entries[1]["uri"] != retryURI {
				t.Errorf("entry[1] = %+v", entries[1])
			}
		})
	}
}

// The result ai-block PERSISTS what it was given, in the {uri,title} shape the
// attr is stored as — that is what renders the chip row (in the document and in
// the command popup, which hosts the same renderer) and what a later read of the
// block shows. The PENDING envelope carries it too, so the chips are there while
// the answer is still in flight.
func TestAIFamily_ResultBlockCarriesThePersistedAttachments(t *testing.T) {
	for _, tc := range aiFamily() {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: "answer"}
			svc := newSmartTestService(t, cap)

			pending, done, _ := runFamilyCommand(t, tc.make(svc), tc.text,
				command.NewContext(nil, attachedPair()), cap)

			for _, attrs := range []map[string]interface{}{pending, done} {
				list, ok := attrs[domain.AttachmentsAttr].([]interface{})
				if !ok || len(list) != 2 {
					t.Fatalf("attachments attr = %#v, want the canonical 2-entry form", attrs[domain.AttachmentsAttr])
				}
				first, ok := list[0].(map[string]interface{})
				if !ok || first["uri"] != authURI || first["title"] != "Auth Design" {
					t.Fatalf("entry[0] = %#v, want the attached {uri,title}", list[0])
				}
			}
		})
	}
}

// An attachment no verb can dereference degrades: the entry renders as
// unavailable, labelled by its title, and the command still runs.
func TestAIFamily_UndereferenceableAttachmentDegradesRatherThanFailing(t *testing.T) {
	for _, tc := range aiFamily() {
		t.Run(tc.name, func(t *testing.T) {
			cap := &captureRunner{ret: "answer"}
			svc := newSmartTestService(t, cap)

			_, done, prompt := runFamilyCommand(t, tc.make(svc), tc.text,
				command.NewContext(nil, []domain.Attachment{{URI: "block:gone", Title: "Deleted Doc"}}), cap)

			if done["status"] != "COMPLETE" || done["response"] != "answer" {
				t.Fatalf("a bad attachment failed the command: %+v", done)
			}
			entries := familyManifestEntries(t, prompt)
			if len(entries) != 1 || entries[0]["unavailable"] != true || entries[0]["title"] != "Deleted Doc" {
				t.Fatalf("degraded entry = %+v", entries)
			}
			if _, hasURI := entries[0]["uri"]; hasURI {
				t.Errorf("an unavailable entry has nothing to fetch: %+v", entries[0])
			}
		})
	}
}

// THE regression that would otherwise slip through: a command invoked with NO
// attachments must produce the prompt it produced before the feature existed.
// The with-attachments prompt is proven to be exactly that prompt plus the
// section, so the attachment-free path adds nothing at all — not even a
// separator — and no attr appears on the block.
func TestAIFamily_NoAttachmentsIsUnchanged(t *testing.T) {
	for _, tc := range aiFamily() {
		t.Run(tc.name, func(t *testing.T) {
			bareCap := &captureRunner{ret: "answer"}
			bare := newSmartTestService(t, bareCap)
			pending, done, barePrompt := runFamilyCommand(t, tc.make(bare), tc.text, command.NewContext(nil, nil), bareCap)

			if strings.Contains(barePrompt, "ATTACHED") {
				t.Fatalf("an attachment-less turn grew a section:\n%s", barePrompt)
			}
			for _, attrs := range []map[string]interface{}{pending, done} {
				if _, present := attrs[domain.AttachmentsAttr]; present {
					t.Fatalf("an attachment-less turn wrote the attr: %#v", attrs[domain.AttachmentsAttr])
				}
			}

			attCap := &captureRunner{ret: "answer"}
			att := newSmartTestService(t, attCap)
			_, _, withPrompt := runFamilyCommand(t, tc.make(att), tc.text,
				command.NewContext(nil, attachedPair()), attCap)

			// Removing the one inserted section must give back the bare prompt
			// byte-for-byte: the section is the ONLY difference between them.
			section := domain.Attachments(attachedPair()).PromptSection()
			if got := strings.Replace(withPrompt, "\n\n"+section, "", 1); got != barePrompt {
				t.Fatalf("the section is not the ONLY difference:\ngot:\n%s\nwant:\n%s", got, barePrompt)
			}
		})
	}
}

// Byte-for-byte, against the template itself: /btw without attachments renders
// exactly the prompt it always did.
func TestBtw_NoAttachments_PromptIsByteIdenticalToTheTemplate(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)

	if _, _, prompt := runFamilyCommand(t, NewBtwCommand(svc, nil), "what is SRP", command.NewContext(nil, nil), cap); prompt !=
		strings.NewReplacer(
			"{question}", "what is SRP",
			"{selection}", "",
			"{doc_title}", "",
			"{doc_summary}", "",
			"{doc_uuid}", "",
		).Replace(DefaultBtwPrompt) {
		t.Fatalf("the attachment-less /btw prompt changed:\n%s", prompt)
	}
}
