import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface SearchOptions {
  searchClass: string
  currentClass: string
}

export interface SearchResult {
  from: number
  to: number
}

const searchPluginKey = new PluginKey('search')

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    search: {
      setSearchTerm: (searchTerm: string) => ReturnType
      nextSearchResult: () => ReturnType
      prevSearchResult: () => ReturnType
      clearSearch: () => ReturnType
    }
  }
}

export const Search = Extension.create<SearchOptions>({
  name: 'search',

  addOptions() {
    return {
      searchClass: 'search-result',
      currentClass: 'search-result-current',
    }
  },

  addStorage() {
    return {
      searchTerm: '',
      results: [] as SearchResult[],
      currentIndex: 0,
    }
  },

  addCommands() {
    return {
      setSearchTerm: (searchTerm: string) => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(searchPluginKey, { searchTerm, updateCurrent: true })
        }
        return true
      },
      nextSearchResult: () => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(searchPluginKey, { next: true })
        }
        return true
      },
      prevSearchResult: () => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(searchPluginKey, { prev: true })
        }
        return true
      },
      clearSearch: () => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(searchPluginKey, { searchTerm: '' })
        }
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const { searchClass, currentClass } = this.options

    return [
      new Plugin({
        key: searchPluginKey,
        state: {
          init() {
            return { searchTerm: '', results: [] as SearchResult[], currentIndex: 0 }
          },
          apply(tr, oldState) {
            const meta = tr.getMeta(searchPluginKey)
            let { searchTerm, results, currentIndex } = oldState

            // Keep results updated when document changes
            const docChanged = tr.docChanged
            const termChanged = meta && meta.searchTerm !== undefined

            if (termChanged) {
              searchTerm = meta.searchTerm
            }

            if (docChanged || termChanged) {
              results = [] as SearchResult[]
              if (searchTerm) {
                const lowerTerm = searchTerm.toLowerCase()
                const termLen = lowerTerm.length
                tr.doc.descendants((node, pos) => {
                  if (node.isText && node.text) {
                    const text = node.text.toLowerCase()
                    let idx = text.indexOf(lowerTerm)
                    while (idx !== -1) {
                      results.push({ from: pos + idx, to: pos + idx + termLen })
                      idx = text.indexOf(lowerTerm, idx + termLen)
                    }
                  }
                })
              }
              // Reset index when term changes or document shrinks
              if (termChanged || meta?.updateCurrent || currentIndex >= results.length) {
                currentIndex = 0
              }
            }

            if (meta?.next && results.length > 0) {
              currentIndex = (currentIndex + 1) % results.length
            }
            if (meta?.prev && results.length > 0) {
              currentIndex = (currentIndex - 1 + results.length) % results.length
            }

            return { searchTerm, results, currentIndex }
          },
        },
        view: (editorView) => {
          const storage = this.storage
          return {
            update: (view, prevState) => {
              const state = searchPluginKey.getState(view.state)
              // Update Extension Storage automatically so the React UI can read it!
              storage.searchTerm = state.searchTerm
              storage.results = state.results
              storage.currentIndex = state.currentIndex

              const oldState = searchPluginKey.getState(prevState)
              // Scroll to active match if it changed
              if (state.results.length > 0 && (state.currentIndex !== oldState?.currentIndex || state.searchTerm !== oldState?.searchTerm)) {
                const current = state.results[state.currentIndex]
                if (current) {
                  // Tiptap's scrollIntoView handles standard scrolling, but we can do it directly:
                  const dom = view.nodeDOM(current.from) as HTMLElement
                  if (dom && dom.scrollIntoView) {
                    dom.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  } else {
                    // Fallback to prosemirror transaction scroll
                    const tr = view.state.tr.setSelection(view.state.selection) // Keep existing selection
                    tr.scrollIntoView() // Warning: scrolls cursor, not necessarily the match. 
                    // We'll manage the scrolling better in the React UI layer by querying the DOM.
                  }
                }
              }
            }
          }
        },
        props: {
          decorations(state) {
            const { results, currentIndex } = searchPluginKey.getState(state)
            if (!results.length) return DecorationSet.empty

            const decos = results.map((res: SearchResult, idx: number) => {
              const isCurrent = idx === currentIndex
              return Decoration.inline(res.from, res.to, {
                class: isCurrent ? `${searchClass} ${currentClass}` : searchClass,
              })
            })

            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})
