import { Extension } from '@tiptap/core'
import { Editor } from '@tiptap/react'

export interface AiShortcutsOptions {
  onExplain: (editor: Editor) => void
  onAsk: (editor: Editor) => void
  onSmartFile: () => void
  onKeepAndSmartFile: () => void
}

export const AiShortcuts = Extension.create<AiShortcutsOptions>({
  name: 'aiShortcuts',

  addKeyboardShortcuts() {
    return {
      'Mod-e': () => {
        this.options.onExplain(this.editor)
        return true
      },
      'Mod-Shift-a': () => {
        this.options.onAsk(this.editor)
        return true
      },
      'Mod-Shift-A': () => {
        this.options.onAsk(this.editor)
        return true
      },
    }
  },
})
