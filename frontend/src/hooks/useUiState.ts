import { useState, useCallback } from 'react'

export function useUiState() {
  const [showHelp, setShowHelp] = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showMeta, setShowMeta] = useState(false)
  const [showPrompts, setShowPrompts] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [showQuickSwitch, setShowQuickSwitch] = useState(false)
  const [showAiBlocks, setShowAiBlocks] = useState(true)
  const [sidebarMode, setSidebarMode] = useState<'files' | 'search'>('files')
  
  const [tier, setTier] = useState<'dumb' | 'smart'>('dumb')
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [metaWidth, setMetaWidth] = useState(260)
  const [promptsHeight, setPromptsHeight] = useState(180)
  const [isDragging, setIsDragging] = useState(false)
  const [isMetaDragging, setIsMetaDragging] = useState(false)
  const [pendingClose, setPendingClose] = useState(false)

  const toggleHelp = useCallback(() => setShowHelp(v => !v), [])
  const toggleSidebar = useCallback(() => setShowSidebar(v => !v), [])
  const toggleMeta = useCallback(() => setShowMeta(v => !v), [])
  const togglePrompts = useCallback(() => setShowPrompts(v => !v), [])
  const toggleSearch = useCallback(() => setShowSearch(v => !v), [])
  const toggleQuickSwitch = useCallback(() => setShowQuickSwitch(v => !v), [])
  const toggleAiBlocks = useCallback(() => setShowAiBlocks(v => !v), [])

  return {
    showHelp, setShowHelp, toggleHelp,
    showSidebar, setShowSidebar, toggleSidebar,
    showMeta, setShowMeta, toggleMeta,
    showPrompts, setShowPrompts, togglePrompts,
    showSearch, setShowSearch, toggleSearch,
    showQuickSwitch, setShowQuickSwitch, toggleQuickSwitch,
    sidebarMode, setSidebarMode,
    tier, setTier,
    sidebarWidth, setSidebarWidth,
    metaWidth, setMetaWidth,
    promptsHeight, setPromptsHeight,
    isDragging, setIsDragging,
    isMetaDragging, setIsMetaDragging,
    pendingClose, setPendingClose,
  }
}
