import { BubbleMenu, Editor } from '@tiptap/react'
import React, { useState } from 'react'
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime'

interface LinkBubbleMenuProps {
  editor: Editor
}

export const LinkBubbleMenu: React.FC<LinkBubbleMenuProps> = ({ editor }) => {
  const [linkUrl, setLinkUrl] = useState('')

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor, from, to }) => {
        return from === to && editor.isActive('link')
      }}
      tippyOptions={{ 
        placement: 'bottom', 
        interactive: true,
        onShow: () => {
          const href = editor.getAttributes('link').href ?? ''
          setLinkUrl(href)
        }
      }}
    >
      <div className="link-bubble">
        <input 
          className="link-bubble__input" 
          value={linkUrl}
          onChange={e => setLinkUrl(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run()
            }
            if (e.key === 'Escape') {
              editor.chain().focus().run()
            }
          }}
          placeholder="https://..." 
        />
        <button 
          className="link-bubble__btn"
          onClick={() => editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run()}
        >
          Set
        </button>
        <button 
          className="link-bubble__btn link-bubble__btn--remove"
          onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
        >
          Remove
        </button>
        <button 
          type="button"
          className="link-bubble__btn"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (linkUrl) BrowserOpenURL(linkUrl)
          }}
        >
          Open
        </button>
      </div>
    </BubbleMenu>
  )
}
