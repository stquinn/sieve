# Implementation Plan: ProseMirror-Native Paste Slices with Sync Endpoint

This document outlines the design to move the Sieve block copy-paste pipeline to be fully ProseMirror-native, leveraging a new synchronous `/api/editor/paste-slice` endpoint instead of async WebSocket pushes or individual sequential fetches. 

---

## Architectural Concept

Instead of walking the slice and calling the smart-paste endpoint for each block individually from the frontend, we send the entire slice of mixed Prose and Sieve blocks to the backend via a single `POST /api/editor/paste-slice`.

This structure directly prepares the application for the upcoming block-document model, where even prose lines will be first-class blocks.

---

## Proposed Changes

### 1. Go Backend

#### Define the Element Structure
Add `PasteSliceElement` struct definition and the `PasteSlice` method to `sieve/editor_service.go`:

```go
// PasteSliceElement represents one node/block within a copied editor slice.
type PasteSliceElement struct {
	Type  string                 `json:"_type"` // "prose" or "sieve"
	Kind  string                 `json:"kind,omitempty"`
	Attrs map[string]interface{} `json:"attrs,omitempty"`
	JSON  map[string]interface{} `json:"json,omitempty"`
	ID    string                 `json:"id,omitempty"`
	Raw   string                 `json:"rawYaml,omitempty"`
}

// PasteSlice processes the entire paste slice on the backend, generating fresh
// IDs and initializing attributes for all Sieve blocks while passing prose through.
func (es *EditorService) PasteSlice(uuid string, elements []PasteSliceElement) ([]PasteSliceElement, error) {
	for i, el := range elements {
		if el.Type == "sieve" {
			blockID := GenerateBlockIDFor(el.Kind)
			id, rawYaml, err := es.createBlockWithID(uuid, el.Kind, blockID, el.Attrs)
			if err != nil {
				return nil, err
			}
			elements[i].ID = id
			elements[i].Raw = rawYaml
			
			// Fetch the newly updated attrs (including status and createdAt) from the shadow
			es.mu.RLock()
			shadow := es.shadows[uuid]
			es.mu.RUnlock()
			if shadow != nil {
				shadow.mu.Lock()
				if blk, ok := shadow.Blocks[id]; ok {
					elements[i].Attrs = blk.Attrs
				}
				shadow.mu.Unlock()
			}
		}
	}
	return elements, nil
}
```

#### Register and Handle the Endpoint
Add the endpoint in `requesthandlers/editor_handler.go`:

1. Inside `RegisterPaths`:
   ```go
   r.Post("/api/editor/paste-slice", h.handlePasteSlice)
   ```

2. Inside `EditorHandler`:
   ```go
   func (h *EditorHandler) handlePasteSlice(w http.ResponseWriter, r *http.Request) {
   	var req struct {
   		UUID  string                  `json:"uuid"`
   		Slice []sieve.PasteSliceElement `json:"slice"`
   	}
   	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UUID == "" {
   		http.Error(w, "bad request", http.StatusBadRequest)
   		return
   	}

   	resSlice, err := h.ServiceProvider.Editor.PasteSlice(req.UUID, req.Slice)
   	if err != nil {
   		http.Error(w, err.Error(), http.StatusInternalServerError)
   		return
   	}

   	w.Header().Set("Content-Type", "application/json")
   	_ = json.NewEncoder(w).Encode(struct {
   		Slice []sieve.PasteSliceElement `json:"slice"`
   	}{
   		Slice: resSlice,
   	})
   }
   ```

---

### 2. Frontend Editor (`frontend/src/static/editor.js`)

#### A. Node Reconstructor Helper
Introduce `createSieveBlockNode` to centralize block node generation:

```javascript
  function createSieveBlockNode(kind, id, rawYaml, preParsedAttrs) {
    var data = preParsedAttrs
    if (!data) {
      try {
        if (rawYaml) {
          data = window.jsyaml.load(rawYaml) || {}
        }
      } catch (e) {
        console.error('[editor.js] failed to parse yaml in createSieveBlockNode', e)
      }
    }
    data = data || {}

    var attrs = {
      kind:            kind || 'code',
      id:              id || data.id || '',
      serialisedForm:  rawYaml || '',
      status:          data.status || 'PENDING',
      createdAt:       data.createdAt || null,
    }
    Object.keys(data).forEach(function (k) {
      if (k !== 'id' && k !== 'status' && k !== 'createdAt') {
        attrs[k] = data[k]
      }
    })

    var newBlock = {
      type: 'sieve-' + (kind || 'code'),
      attrs: attrs,
    }

    if (currentEditor) {
      var nodeType = currentEditor.schema.nodes[newBlock.type]
      if (nodeType && nodeType.spec.content) {
        if (nodeType.spec.content.indexOf('block') !== -1) {
          newBlock.content = [{ type: 'paragraph' }]
        } else if (nodeType.spec.content.indexOf('text') !== -1 && attrs.source) {
          newBlock.content = [{ type: 'text', text: attrs.source }]
        }
      }
    }
    return newBlock
  }
```

#### B. Slice Reconstructor (Section 1b)
Replace the client-only reconstructor with a call to the new endpoint:

```javascript
    // ── 1b. sieve/slice reconstruct ──────────────────────────────────────────────
    var sliceData = event.clipboardData.getData('sieve/slice')
    if (sliceData) {
      event.preventDefault()
      fetch('/api/editor/paste-slice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: currentUuid, slice: JSON.parse(sliceData) }),
      })
        .then(function (r) { return r.json() })
        .then(function (result) {
          if (!currentEditor) return
          var sliceContent = result.slice.map(function (entry) {
            if (entry._type === 'prose') {
              return entry.json
            }
            if (entry.id) {
              return createSieveBlockNode(entry.kind, entry.id, entry.rawYaml, entry.attrs)
            } else {
              console.error('SIEVE BLOCK not handled', entry.kind, entry)
              return null
            }
          }).filter(Boolean)
          
          currentEditor.commands.insertContent(sliceContent)
        })
        .catch(function (err) {
          console.error('[editor.js] paste-slice fetch failed', err)
        })
      return true
    }
```

#### C. WebSocket `insert-block` Duplicate Check
Add a check in the WebSocket `insert-block` listener to prevent double insertion of blocks that were already inserted synchronously:

```javascript
    // Check if the block already exists in the editor to avoid duplicate insertion on sync paste
    var exists = false
    currentEditor.state.doc.descendants(function (node) {
      if (node.type.name.startsWith('sieve-') && node.attrs.id === (msg.id || parsed.id)) {
        exists = true
        return false
      }
    })
    if (exists) return
```

---

## Verification Steps

1. **Build and Validate Compilations**:
   - Go: `nix-shell --command "go build -tags webkit2_41"`
   - Frontend: `nix-shell --command "cd frontend && npm run build"`
   - Typecheck: `nix-shell --command "cd frontend && npx tsc"`
2. **Interactive Testing**:
   - Copy a mix of Sieve blocks (e.g. Code, Diagram) and text in WYSIWYG mode.
   - Paste it and verify that block ordering is completely preserved.
   - Check developer tools console to ensure that there are no duplicate ID errors or race warnings.
