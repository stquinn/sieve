package domain

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// FilingRecommendation mirrors the expected JSON structure from the AI.
// It is a shared data type at the AI<->Document boundary (AIService produces it,
// DocumentService.UpdateAiMetadata consumes it), so it lives in the leaf to keep
// both sides off each other's import path.
type FilingRecommendation struct {
	Keep            bool     `json:"keep"`
	Title           string   `json:"title"`
	Filename        string   `json:"filename"`
	Folder          string   `json:"folder"`
	NewFolder       bool     `json:"new_folder"`
	Type            string   `json:"type"`
	Summary         string   `json:"summary"`
	Tags            []string `json:"tags"`
	AiJustification string   `json:"ai_justification"`
	DensitySignals  []string `json:"density_signals"`
}

// ImageDesc is the structured response from AIService.DescribeImage. It is a
// shared data type consumed by block processors' DescribeJob (via *ai.AIService),
// so it lives in the leaf domain/ that both ai/ and block/ can name.
type ImageDesc struct {
	Filename string `json:"filename"`
	Alt      string `json:"alt"`
	Summary  string `json:"summary"`
	Detect   string `json:"detect,omitempty"`
}

// NoteMetadata is what a model says of a thing it was shown, a handwritten note from images of its
// pages or a chat from its thread: a title, its keywords, the categories it belongs to and a
// summary. It is what AIService.DescribeNote and AIService.DescribeChat answer, what ink keeps on
// a note and sends to the tablet, and what a chat keeps; nothing checks it beyond its parse.
type NoteMetadata struct {
	Title      string   `json:"title"`
	Keywords   []string `json:"keywords"`
	Categories []string `json:"categories"`
	Summary    string   `json:"summary"`
	// CLI is the AI CLI that gave the description, "" when it is not known. It is not part of
	// what the model says: the run reports it, and WriteTo records it.
	CLI string `json:"-"`
}

// The .meta keys a description (NoteMetadata) is kept under beside display_name, summary and tags:
// its keywords and categories, each a JSON array of strings; how far the thing stood when it was
// described, a note's log seq or a chat's count of answered exchanges, in decimal; and who names
// the thing, MetaNamedByHand for a person.
const (
	MetaKeyKeywords   = "note_keywords"
	MetaKeyCategories = "note_categories"
	MetaKeyDescribed  = "note_meta_seq"
	MetaKeyNamedBy    = "note_named_by"
)

// MetaNamedByHand is the MetaKeyNamedBy of a thing a person named: a description keeps its name.
const MetaNamedByHand = "hand"

// WriteTo writes d into meta as the thing's description of how far it stood at described: Title as
// display_name unless keepName, Summary, Keywords as tags, Keywords and Categories whole under
// MetaKeyKeywords and MetaKeyCategories, and described under MetaKeyDescribed. A d that names its
// CLI is also recorded as DocumentMeta.RecordAiRun records a run, at the time of the write. A comma
// in a keyword is a semicolon in tags, whose stored form splits on commas.
func (d NoteMetadata) WriteTo(meta DocumentMeta, keepName bool, described uint64) {
	if !keepName {
		meta.SetDisplayName(strings.TrimSpace(d.Title))
	}
	summary := strings.TrimSpace(d.Summary)
	if summary == "" {
		meta.SetSummary(nil)
	} else {
		meta.SetSummary(&summary)
	}
	tags := make([]string, 0, len(d.Keywords))
	for _, kw := range d.Keywords {
		if tag := strings.TrimSpace(strings.ReplaceAll(kw, ",", ";")); tag != "" {
			tags = append(tags, tag)
		}
	}
	meta.SetTags(tags)
	all := meta.All()
	all[MetaKeyKeywords], all[MetaKeyCategories] = d.terms(d.Keywords), d.terms(d.Categories)
	all[MetaKeyDescribed] = strconv.FormatUint(described, 10)
	if d.CLI != "" {
		meta.RecordAiRun(d.CLI, time.Now())
	}
}

// ReadFrom sets d's Summary, Keywords and Categories to those meta holds, as WriteTo wrote them;
// its Title, which each owner reads by its own rule, is left alone.
func (d *NoteMetadata) ReadFrom(meta map[string]string) {
	d.Summary = meta["summary"]
	if d.Summary == "null" {
		d.Summary = ""
	}
	d.Keywords, d.Categories = nil, nil
	_ = json.Unmarshal([]byte(meta[MetaKeyKeywords]), &d.Keywords)
	_ = json.Unmarshal([]byte(meta[MetaKeyCategories]), &d.Categories)
}

// terms is list as a JSON array of strings, [] for none.
func (NoteMetadata) terms(list []string) string {
	if list == nil {
		list = []string{}
	}
	raw, _ := json.Marshal(list)
	return string(raw)
}
