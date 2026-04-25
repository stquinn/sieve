package filestore

import "sieve/store"

// inferEncoding inspects the leading bytes of data to determine its on-disk
// encoding. FileStore calls this once at Create time and stamps the result on
// the AssetStorable — callers never declare the encoding.
//
// Decision table (checked in order):
//
//	PK\x03\x04         → Zipped   (ZIP magic bytes)
//	all base64 chars   → Base64   (frontend sends base64-encoded images)
//	anything else      → Raw
func inferEncoding(data []byte) store.Encoding {
	if len(data) == 0 {
		return store.Raw
	}
	// ZIP magic bytes: PK\x03\x04
	if len(data) >= 4 &&
		data[0] == 0x50 && data[1] == 0x4B &&
		data[2] == 0x03 && data[3] == 0x04 {
		return store.Zipped
	}
	if isValidBase64(data) {
		return store.Base64
	}
	return store.Raw
}

// isValidBase64 reports whether every byte in data belongs to the standard
// base64 alphabet (A–Z, a–z, 0–9, +, /, =) and the length is a multiple of 4.
// A minimum length of 4 is required to avoid false positives on short strings.
func isValidBase64(data []byte) bool {
	if len(data) < 4 || len(data)%4 != 0 {
		return false
	}
	for _, b := range data {
		if !((b >= 'A' && b <= 'Z') ||
			(b >= 'a' && b <= 'z') ||
			(b >= '0' && b <= '9') ||
			b == '+' || b == '/' || b == '=') {
			return false
		}
	}
	return true
}
