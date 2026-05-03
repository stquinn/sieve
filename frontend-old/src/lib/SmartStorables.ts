import { main } from '../../wailsjs/go/models'

/**
 * SMART STORABLE AUGMENTATION
 * 
 * We augment the prototypes of the auto-generated Wails DTOs so they satisfy
 * the Storable interface. This ensures that every instance returned by the 
 * backend (via createFrom) "knows" its own identity and modified state.
 * 
 * This file MUST be imported early in App.tsx.
 */

// 1. Tell TypeScript that these classes now have additional properties & methods
declare module '../../wailsjs/go/models' {
  namespace main {
    interface BufferDTO {
      readonly id: string
      isModified: boolean
      setBody(v: string): void
      setMeta(m: main.DocumentMetaDTO): void
    }
    interface NoteDTO {
      readonly id: string
      isModified: boolean
      setBody(v: string): void
      setMeta(m: main.DocumentMetaDTO): void
    }
  }
}

// 2. Concrete implementation for BufferDTO
Object.defineProperty(main.BufferDTO.prototype, 'id', {
  get: function() { return this.uuid; },
  configurable: true
});

main.BufferDTO.prototype.isModified = false;

main.BufferDTO.prototype.setBody = function(this: main.BufferDTO, v: string) {
  if (this.body !== v) {
    this.body = v;
    this.isModified = true;
  }
};

main.BufferDTO.prototype.setMeta = function(this: main.BufferDTO, m: main.DocumentMetaDTO) {
  this.meta = m;
  this.isModified = true;
};

// 3. Concrete implementation for NoteDTO
Object.defineProperty(main.NoteDTO.prototype, 'id', {
  get: function() { return this.uuid; },
  configurable: true
});

main.NoteDTO.prototype.isModified = false;

main.NoteDTO.prototype.setBody = function(this: main.NoteDTO, v: string) {
  if (this.body !== v) {
    this.body = v;
    this.isModified = true;
  }
};

main.NoteDTO.prototype.setMeta = function(this: main.NoteDTO, m: main.DocumentMetaDTO) {
  this.meta = m;
  this.isModified = true;
};

console.log('[stash] Smart Storables augmented');
