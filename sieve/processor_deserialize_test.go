package sieve

import "testing"

// Every registered processor must satisfy the expanded interface AND every
// block-mode processor must claim a region of its own kind. This locks in that
// the embeds were wired with the right Kind.
func TestAllBlockProcessorsRecogniseTheirKind(t *testing.T) {
	cases := map[string]string{
		"code": "id: co-1\n", "diagram": "id: dg-1\n", "ai-block": "id: ai-1\n",
		"log": "id: lo-1\n", "web-clip": "id: we-1\n", "smart-image": "id: im-1\n",
		"smart-card": "id: sc-1\n",
	}
	svc := BlockServices{}
	ctors := map[string]BlockProcessor{
		"code": NewCodeBlockProcessor(svc), "diagram": NewDiagramProcessor(svc),
		"ai-block": NewAIBlockProcessor(svc), "log": NewLogProcessor(svc),
		"web-clip": NewWebClipBlockProcessor(svc), "smart-image": NewSmartImageProcessor(svc),
		"smart-card": NewSmartCardProcessor(svc),
	}
	for kind, body := range cases {
		p := ctors[kind]
		if !p.Accepts(Region{Kind: kind, Body: body}) {
			t.Errorf("%s processor does not Accept its own region", kind)
		}
		if p.Accepts(Region{Kind: "other", Body: body}) {
			t.Errorf("%s processor wrongly Accepts a foreign kind", kind)
		}
	}
}
