package domain

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
// return type of block.AIPort, so it lives in the leaf (block/ must be able to
// name it without importing ai/).
type ImageDesc struct {
	Filename string `json:"filename"`
	Alt      string `json:"alt"`
	Summary  string `json:"summary"`
	Detect   string `json:"detect,omitempty"`
}
