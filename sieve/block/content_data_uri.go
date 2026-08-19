package block

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// IsDataURI reports whether this entry's content is a `data:` URI — the shape a
// browser produces for a file it has read (FileReader.readAsDataURL) and for a
// binary clipboard payload. It is the entry's OWN question because more than one
// kind asks it: smart-image ingests a pasted image this way and attachment
// ingests a dropped file, and a second spelling of the same prefix test is a
// second place for the two to disagree.
func (e ContentEntry) IsDataURI() bool {
	return strings.HasPrefix(strings.TrimSpace(e.Content), "data:")
}

// DecodeDataURI reads the bytes this entry's `data:` URI carries. The metadata
// half declares the payload encoding, so both shapes a browser produces are
// honoured: `;base64` (a file read, a raster paste, and most SVG sources) and a
// percent-encoded text payload (the shape an SVG data URI takes when it is not
// base64'd).
func (e ContentEntry) DecodeDataURI() ([]byte, error) {
	meta, payload, ok := strings.Cut(e.Content, ",")
	if !ok {
		return nil, errors.New("invalid data URI: no comma separator")
	}

	if !strings.Contains(meta, ";base64") {
		text, err := url.PathUnescape(payload)
		if err != nil {
			return nil, fmt.Errorf("percent-decode: %w", err)
		}
		return []byte(text), nil
	}

	// Clipboard sources wrap the payload; whitespace is not part of the alphabet.
	b64 := strings.NewReplacer("\n", "", "\r", "", "\t", "", " ", "").Replace(payload)
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err == nil {
		return raw, nil
	}
	if urlAlphabet, urlErr := base64.URLEncoding.DecodeString(b64); urlErr == nil {
		return urlAlphabet, nil
	}
	return nil, fmt.Errorf("base64 decode (%d chars): %w", len(b64), err)
}
