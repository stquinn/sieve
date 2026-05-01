import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import 'highlight.js/styles/tokyo-night-dark.css'
import App from './App'

// Suppress the default browser/WebKit context menu everywhere except the editor,
// where cut/copy/paste is genuinely useful. Sidebar, tab bar, meta panel etc.
// will get their own custom menus as they are built.
document.addEventListener('contextmenu', e => {
  const inEditor = (e.target as Element).closest('#app')
  if (!inEditor) e.preventDefault()
})

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(<App/>)
