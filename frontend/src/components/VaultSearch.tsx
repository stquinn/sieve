import React, { useEffect, useState, useRef } from 'react'
import { SearchVault } from '../../wailsjs/go/main/App'
import { vault } from '../../wailsjs/go/models'
import { Search, X, FileText } from 'lucide-react'

interface Props {
  width: number
  onOpen: (path: string) => void
  onClose: () => void
}

export function VaultSearch({ width, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<vault.SearchResult[]>([])
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
      SearchVault(query).then(res => {
        setResults(res || [])
        setIsSearching(false)
      }).catch(console.error)
    }, 300)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  return (
    <div className="vault-search" style={{ width, minWidth: width, maxWidth: width }}>
      <div className="vault-search__header">
        <h2 className="vault-search__title">
          <Search size={14} /> Vault Search
        </h2>
        <button className="vault-search__close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="vault-search__input-wrapper">
        <input
          ref={inputRef}
          className="vault-search__input"
          placeholder="Search all notes..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
          }}
        />
      </div>

      <div className="vault-search__results">
        {isSearching && <div className="vault-search__msg">Searching...</div>}
        {!isSearching && query && results.length === 0 && (
          <div className="vault-search__msg">No matches found for "{query}"</div>
        )}
        
        {!isSearching && results.map(res => (
          <div key={res.path} className="vault-search__item" onClick={() => onOpen(res.path)}>
            <div className="vault-search__item-top">
              <div className="vault-search__item-info">
                <FileText size={14} className="vault-search__item-icon" />
                <span className="vault-search__item-name">{res.name}</span>
              </div>
              <div className="vault-search__item-badges">
                {res.isTagMatch && <span className="vault-search__badge">tag</span>}
                {res.isSummaryMatch && <span className="vault-search__badge">summary</span>}
                {res.isBodyMatch && <span className="vault-search__badge vault-search__badge--text">text</span>}
              </div>
            </div>
            {res.snippet && <div className="vault-search__item-snippet">{res.snippet}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
