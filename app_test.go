package main

import "testing"

func TestIsBodyEmpty(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"empty string", "", true},
		{"whitespace only", "   \t\n  ", true},
		{"empty paragraph", "<p></p>", true},
		{"empty paragraph with space", "<p> </p>", true},
		{"nested empty tags", "<div><p></p></div>", true},
		{"self-closing tags only", "<br/><hr/>", true},
		{"text content", "hello", false},
		{"text in paragraph", "<p>hello</p>", false},
		{"text in nested tags", "<div><p>hello</p></div>", false},
		{"whitespace around tags with text", "  <p>  x  </p>  ", false},
		{"multiple empty paragraphs", "<p></p><p></p><p></p>", true},
		{"single non-whitespace char", "x", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isBodyEmpty(tt.input)
			if got != tt.want {
				t.Errorf("isBodyEmpty(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}
