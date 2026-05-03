package store_test

import (
	"testing"

	"sieve/store"
)

func TestEncodingValues(t *testing.T) {
	tests := []struct {
		name string
		enc  store.Encoding
		want int
	}{
		{"Raw", store.Raw, 0},
		{"Base64", store.Base64, 1},
		{"LZCompressed", store.LZCompressed, 2},
		{"Zipped", store.Zipped, 3},
	}
	for _, tt := range tests {
		if int(tt.enc) != tt.want {
			t.Errorf("%s = %d, want %d", tt.name, tt.enc, tt.want)
		}
	}
}

func TestEncodingValuesAreDistinct(t *testing.T) {
	encs := []store.Encoding{store.Raw, store.Base64, store.LZCompressed, store.Zipped}
	seen := make(map[store.Encoding]bool)
	for _, e := range encs {
		if seen[e] {
			t.Errorf("duplicate Encoding value %d", e)
		}
		seen[e] = true
	}
}

func TestEncodingString(t *testing.T) {
	tests := []struct {
		enc  store.Encoding
		want string
	}{
		{store.Raw, "raw"},
		{store.Base64, "base64"},
		{store.LZCompressed, "lz-compressed"},
		{store.Zipped, "zipped"},
		{store.Encoding(99), "unknown"},
	}
	for _, tt := range tests {
		got := tt.enc.String()
		if got != tt.want {
			t.Errorf("Encoding(%d).String() = %q, want %q", tt.enc, got, tt.want)
		}
	}
}

func TestEncodingStringCoversAllConstants(t *testing.T) {
	// Ensures no constant returns "unknown", catching any iota gaps.
	known := []store.Encoding{store.Raw, store.Base64, store.LZCompressed, store.Zipped}
	for _, e := range known {
		if e.String() == "unknown" {
			t.Errorf("Encoding(%d).String() = %q — constant is missing from String()", e, e.String())
		}
	}
}
