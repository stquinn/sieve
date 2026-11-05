package filestore

import "sieve/store"

// sniffLen is how many leading bytes of an asset's file inferEncoding is given.
const sniffLen = 512

// inferEncoding determines an asset's on-disk encoding from head, the first
// sniffLen bytes of its file (all of it when shorter), and size, the file's
// full length. FileStore calls it once when an asset storable is built; callers
// never declare the encoding.
//
// Decision table (checked in order):
//
//	PK\x03\x04                             → Zipped (ZIP magic bytes)
//	head all base64 chars, size % 4 == 0   → Base64 (frontend sends base64-encoded images)
//	anything else                          → Raw
//
// For a file longer than sniffLen the base64 verdict rests on its head alone.
func inferEncoding(head []byte, size int64) store.Encoding {
	if len(head) == 0 {
		return store.Raw
	}
	if len(head) >= 4 &&
		head[0] == 0x50 && head[1] == 0x4B &&
		head[2] == 0x03 && head[3] == 0x04 {
		return store.Zipped
	}
	if size >= 4 && size%4 == 0 && onlyBase64Chars(head) {
		return store.Base64
	}
	return store.Raw
}

// onlyBase64Chars reports whether every byte in data belongs to the standard
// base64 alphabet (A–Z, a–z, 0–9, +, /, =).
func onlyBase64Chars(data []byte) bool {
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
