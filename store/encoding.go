package store

// Encoding describes how an AssetStorable's bytes are packaged on disk or in
// transit. The Store infers and stamps Encoding from magic bytes at Create
// time — callers never declare it.
type Encoding int

const (
	// Raw bytes are stored as-is with no additional encoding layer.
	Raw Encoding = iota
	// Base64 bytes are standard base64-encoded.
	Base64
	// LZCompressed bytes are LZ-compressed.
	LZCompressed
	// Zipped bytes are zip-compressed.
	Zipped
)

// String returns the wire-format name of the encoding. The values align with
// the TypeScript Asset.encoding union type.
func (e Encoding) String() string {
	switch e {
	case Raw:
		return "raw"
	case Base64:
		return "base64"
	case LZCompressed:
		return "lz-compressed"
	case Zipped:
		return "zipped"
	default:
		return "unknown"
	}
}
