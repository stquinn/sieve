import React, { useEffect, useState, useRef } from 'react'
import { SearchStore } from '../../wailsjs/go/main/App'
import { stash } from '../../wailsjs/go/models'
import { Search, X, FileText } from 'lucide-react'

interface Props {
  width: number
  onOpen: (path: string) => void
  onClose: () => void
}

export function StoreSearch({ width, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<stash.SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Focus instantly on mount
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      setIsSearching(false)
      return
    }

    setIsSearching(true)
    debounceRef.current = setTimeout(() => {
      SearchStore(query).then(res => {
        setResults(res || [])
        setIsSearching(false)
      }).catch(console.error)
    }, 300)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  return (
    <div className="store-search" style={{ width, minWidth: width, maxWidth: width }}>
      <div className="store-search__header">
        <h2 className="store-search__title">
          <Search size={14} /> Store Search
        </h2>
        <button className="store-search__close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="store-search__input-wrapper">
        <input
          ref={inputRef}
          className="store-search__input"
          placeholder="Search all notes..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
          }}
        />
      </div>

      <div className="store-search__results">
        {isSearching && <div className="store-search__msg">Searching...</div>}
        {!isSearching && query && results.length === 0 && (
          <div className="store-search__msg">No matches found for "{query}"</div>
        )}
        
        {!isSearching && results.map(res => (
          <div key={res.path} className="store-search__item" onClick={() => onOpen(res.path)}>
            <div className="store-search__item-top">
              <div className="store-search__item-info">
                <FileText size={14} className="store-search__item-icon" />
                <span className="store-search__item-name">{res.name}</span>
              </div>
              <div className="store-search__item-badges">
                {res.isTagMatch && <span className="store-search__badge">tag</span>}
                {res.isSummaryMatch && <span className="store-search__badge">summary</span>}
                {res.isBodyMatch && <span className="store-search__badge store-search__badge--text">text</span>}
              </div>
            </div>
            {res.snippet && <div className="store-search__item-snippet">{res.snippet}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
