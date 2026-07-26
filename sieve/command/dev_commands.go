package command

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"time"

	"sieve/sieve/services"
)

// ─── /uuid ───────────────────────────────────────────────────────────────────

type UUIDCommand struct{}

func NewUUIDCommand() *UUIDCommand { return &UUIDCommand{} }

func (c *UUIDCommand) Name() string        { return "uuid" }
func (c *UUIDCommand) Description() string { return "Generate a new random UUID v4" }

func (c *UUIDCommand) Build(text string, ctx Context) (Job, error) {
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "Generate UUID (/uuid)",
		"type":      "UUID",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	return Job{
		Label:   "/uuid",
		Pending: pending,
		Work: func() (Block, error) {
			b := make([]byte, 16)
			if _, err := rand.Read(b); err != nil {
				return Block{}, err
			}
			// RFC 4122 version 4, variant bits
			b[6] = (b[6] & 0x0f) | 0x40
			b[8] = (b[8] & 0x3f) | 0x80
			uuid := fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
				b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])

			resp := strings.Join([]string{
				"### 🔑 UUID v4 (`/uuid`)",
				"",
				"```",
				uuid,
				"```",
				"",
				fmt.Sprintf("*Generated at %s*", time.Now().UTC().Format(time.RFC3339)),
			}, "\n")

			done := cloneAttrs(attrs)
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// ─── /hash ───────────────────────────────────────────────────────────────────

type HashCommand struct {
	docs *services.DocumentService
}

func NewHashCommand(docs *services.DocumentService) *HashCommand { return &HashCommand{docs: docs} }

func (c *HashCommand) Name() string        { return "hash" }
func (c *HashCommand) Description() string { return "SHA-256 hash of inline text, selection, or document" }

func (c *HashCommand) Build(text string, ctx Context) (Job, error) {
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "SHA-256 Hash (/hash)",
		"type":      "HASH",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	return Job{
		Label:   "/hash",
		Pending: pending,
		Work: func() (Block, error) {
			content, scope := resolveDevContent(text, ctx, c.docs)
			if content == "" {
				return Block{}, fmt.Errorf("/hash: no content to hash — provide text, make a selection, or open a document")
			}

			sum := sha256.Sum256([]byte(content))
			hexHash := hex.EncodeToString(sum[:])

			var inputLine string
			if scope == "Document" {
				inputLine = fmt.Sprintf("*Input: **Document** %s*", devScopeNote(content, scope))
			} else {
				inputLine = fmt.Sprintf("*Input (%s): `%s`*", scope, content)
			}

			resp := strings.Join([]string{
				"### 🔐 SHA-256 Hash (`/hash`)",
				"",
				inputLine,
				"",
				"| | |",
				"| :--- | :--- |",
				fmt.Sprintf("| **SHA-256** | `%s` |", hexHash),
				fmt.Sprintf("| **Bytes hashed** | `%d` |", len([]byte(content))),
			}, "\n")

			done := cloneAttrs(attrs)
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// ─── /base64 ─────────────────────────────────────────────────────────────────

type Base64Command struct {
	docs *services.DocumentService
}

func NewBase64Command(docs *services.DocumentService) *Base64Command {
	return &Base64Command{docs: docs}
}

func (c *Base64Command) Name() string        { return "base64" }
func (c *Base64Command) Description() string { return "Base64 encode/decode inline text, selection, or document" }

func (c *Base64Command) Build(text string, ctx Context) (Job, error) {
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "Base64 Encode/Decode (/base64)",
		"type":      "BASE64",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	return Job{
		Label:   "/base64",
		Pending: pending,
		Work: func() (Block, error) {
			content, scope := resolveDevContent(text, ctx, c.docs)
			if content == "" {
				return Block{}, fmt.Errorf("/base64: no content — provide text, make a selection, or open a document")
			}

			trimmed := strings.TrimSpace(content)
			var resp string

			var inputLine string
			if scope == "Document" {
				inputLine = fmt.Sprintf("*Input: **Document** %s*", devScopeNote(content, scope))
			} else {
				inputLine = fmt.Sprintf("*Input (%s): `%s`*", scope, content)
			}

			// If no inline text was given and the content looks like base64, try decode.
			isLikelyEncoded := strings.TrimSpace(text) == "" &&
				!strings.ContainsAny(trimmed, " \t\n") &&
				len(trimmed)%4 == 0

			if isLikelyEncoded {
				if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil {
					resp = strings.Join([]string{
						"### 📦 Base64 Decoded (`/base64`)",
						"",
						inputLine,
						"",
						"**Decoded:**",
						"```",
						string(decoded),
						"```",
						fmt.Sprintf("*(%d chars → %d bytes)*", len(trimmed), len(decoded)),
					}, "\n")
				}
			}

			// Default: encode
			if resp == "" {
				encoded := base64.StdEncoding.EncodeToString([]byte(content))
				resp = strings.Join([]string{
					"### 📦 Base64 Encoded (`/base64`)",
					"",
					inputLine,
					"",
					"**Encoded:**",
					"```",
					encoded,
					"```",
					fmt.Sprintf("*(%d bytes → %d chars)*", len([]byte(content)), len(encoded)),
				}, "\n")
			}

			done := cloneAttrs(attrs)
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// ─── /env ────────────────────────────────────────────────────────────────────

type EnvCommand struct{}

func NewEnvCommand() *EnvCommand { return &EnvCommand{} }

func (c *EnvCommand) Name() string        { return "env" }
func (c *EnvCommand) Description() string { return "Go runtime info: OS, arch, CPUs, goroutines, memory" }

func (c *EnvCommand) Build(text string, ctx Context) (Job, error) {
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "Runtime Environment (/env)",
		"type":      "ENV",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	return Job{
		Label:   "/env",
		Pending: pending,
		Work: func() (Block, error) {
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)

			resp := strings.Join([]string{
				"### 🖥️ Runtime Environment (`/env`)",
				"",
				"| Key | Value |",
				"| :--- | :--- |",
				fmt.Sprintf("| **Go Version** | `%s` |", runtime.Version()),
				fmt.Sprintf("| **OS** | `%s` |", runtime.GOOS),
				fmt.Sprintf("| **Arch** | `%s` |", runtime.GOARCH),
				fmt.Sprintf("| **CPUs** | `%d` |", runtime.NumCPU()),
				fmt.Sprintf("| **Goroutines** | `%d` |", runtime.NumGoroutine()),
				fmt.Sprintf("| **Heap Alloc** | `%s` |", formatDevBytes(ms.HeapAlloc)),
				fmt.Sprintf("| **Heap Sys** | `%s` |", formatDevBytes(ms.HeapSys)),
				fmt.Sprintf("| **GC Cycles** | `%d` |", ms.NumGC),
			}, "\n")

			done := cloneAttrs(attrs)
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// ─── /jwt ────────────────────────────────────────────────────────────────────

type JWTCommand struct{}

func NewJWTCommand() *JWTCommand { return &JWTCommand{} }

func (c *JWTCommand) Name() string        { return "jwt" }
func (c *JWTCommand) Description() string { return "Decode & inspect a JWT header + payload (no signature verification)" }

func (c *JWTCommand) Build(text string, ctx Context) (Job, error) {
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "JWT Decode (/jwt)",
		"type":      "JWT",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	// Capture token at Build time: inline text > selection
	token := strings.TrimSpace(text)
	if token == "" {
		token = strings.TrimSpace(ctx.SelectedText)
	}

	return Job{
		Label:   "/jwt",
		Pending: pending,
		Work: func() (Block, error) {
			if token == "" {
				return Block{}, fmt.Errorf("/jwt: provide a token as inline text or select one first")
			}
			parts := strings.Split(token, ".")
			if len(parts) != 3 {
				return Block{}, fmt.Errorf("/jwt: expected 3 dot-separated parts, got %d", len(parts))
			}

			headerJSON, err := jwtDecodeSegment(parts[0])
			if err != nil {
				return Block{}, fmt.Errorf("/jwt: invalid header: %w", err)
			}
			payloadJSON, err := jwtDecodeSegment(parts[1])
			if err != nil {
				return Block{}, fmt.Errorf("/jwt: invalid payload: %w", err)
			}

			resp := strings.Join([]string{
				"### 🔑 JWT Decoded (`/jwt`)",
				"",
				"> ⚠️ **Signature NOT verified** — header & payload only",
				"",
				"**Header:**",
				"```json",
				headerJSON,
				"```",
				"",
				"**Payload:**",
				"```json",
				payloadJSON,
				"```",
			}, "\n")

			done := cloneAttrs(attrs)
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// ─── shared helpers ───────────────────────────────────────────────────────────

// resolveDevContent applies the priority rule: inline text > selection > document.
func resolveDevContent(text string, ctx Context, docs *services.DocumentService) (string, string) {
	if t := strings.TrimSpace(text); t != "" {
		return text, "Inline Text"
	}
	if s := strings.TrimSpace(ctx.SelectedText); s != "" {
		return ctx.SelectedText, "Selected Text"
	}
	if ctx.DocUUID != "" && docs != nil {
		if doc, err := docs.LoadByUUID(ctx.DocUUID); err == nil {
			body := string(doc.Body())
			if strings.TrimSpace(body) != "" {
				return body, "Document"
			}
		}
	}
	return "", ""
}

// devScopeNote returns a parenthetical byte/word count for scope clarity.
func devScopeNote(content, scope string) string {
	n := len([]byte(content))
	if scope == "Document" {
		words := len(strings.Fields(content))
		return fmt.Sprintf("(%d bytes, %d words)", n, words)
	}
	return fmt.Sprintf("(%d bytes)", n)
}

// cloneAttrs shallow-copies an attrs map so Work closures don't race on writes.
func cloneAttrs(src map[string]interface{}) map[string]interface{} {
	dst := make(map[string]interface{}, len(src)+3)
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func formatDevBytes(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

func jwtDecodeSegment(seg string) (string, error) {
	// JWT uses base64url without padding — restore padding before decoding.
	padded := seg
	switch len(padded) % 4 {
	case 2:
		padded += "=="
	case 3:
		padded += "="
	}
	raw, err := base64.URLEncoding.DecodeString(padded)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return string(raw), nil // not JSON — return raw bytes as string
	}
	return buf.String(), nil
}
