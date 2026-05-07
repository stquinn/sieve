import "/wails/runtime.js";
(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload")
          processPreload(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials")
      fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep)
      return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
const T = window.TipTap;
const SmartLink = T.Node.create({
  name: "smartLink",
  priority: 1100,
  group: "inline",
  inline: true,
  atom: true,
  // Crucial: Makes it a single selectable entity for your async jobs
  parseHTML() {
    return [
      {
        tag: "a[data-block-id]",
        // Target links that specifically have our custom ID
        priority: 1100
      },
      {
        tag: "a",
        priority: 1e3
      }
    ];
  },
  addAttributes() {
    return {
      id: {
        default: null,
        // Map the HTML attribute 'data-block-id' to the node attribute 'id'
        parseHTML: (el) => el.getAttribute("data-block-id"),
        renderHTML: (attrs) => attrs.id ? { "data-block-id": attrs.id } : {}
      },
      href: {
        default: null,
        parseHTML: (el) => el.getAttribute("href"),
        renderHTML: (attrs) => attrs.href ? { "href": attrs.href } : {}
      },
      label: {
        default: null,
        // CRITICAL: This pulls the text inside <a>Text</a> and saves it as the 'label' attribute
        parseHTML: (el) => el.innerText || el.textContent,
        renderHTML: (attrs) => ({})
        // We don't render this as an attribute, it's the tag content
      },
      detect: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-detect"),
        renderHTML: (attrs) => attrs.detect ? { "data-detect": attrs.detect } : {}
      }
    };
  },
  addNodeView() {
    return function({ node }) {
      const dom = document.createElement("a");
      dom.classList.add("smart-link-node");
      dom.href = node.attrs.href || "#";
      dom.textContent = node.attrs.label || node.attrs.href;
      dom.title = "Ctrl+Click to open in browser";
      if (node.attrs.detect) dom.setAttribute("data-detect", node.attrs.detect);
      if (node.attrs.id) dom.setAttribute("data-block-id", node.attrs.id);
      const handleNavigation = (e) => {
        const isModifierPressed = window.isMod(e);
        if (isModifierPressed) {
          e.preventDefault();
          e.stopPropagation();
          const href = node.attrs.href;
          if (href && window.wails && window.wails.Browser) {
            window.wails.Browser.OpenURL(href);
          }
          return true;
        }
        return false;
      };
      dom.addEventListener("mousedown", function(e) {
        if (handleNavigation(e)) {
          return;
        }
      });
      dom.addEventListener("click", function(e) {
        if (window.isMod(e)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        if (typeof getPos === "function") {
          editor.commands.setNodeSelection(getPos());
        }
      });
      return {
        dom,
        // Ensure that if the attributes change (async), the text updates
        update: function(updatedNode) {
          if (updatedNode.type.name !== node.type.name) return false;
          dom.textContent = updatedNode.attrs.label || updatedNode.attrs.href;
          dom.href = updatedNode.attrs.href || "#";
          return true;
        }
      };
    };
  },
  onCreate() {
    if (!this.storage.bubble) {
      this.storage.bubble = createLinkBubble(this.editor);
    }
  },
  onDestroy() {
    if (this.storage.bubble) {
      this.storage.bubble.remove();
      this.storage.bubble = null;
    }
  },
  onSelectionUpdate() {
    const { editor: editor2, storage } = this;
    const bubble = storage.bubble;
    if (!bubble) return;
    if (!editor2.isActive("smartLink")) {
      bubble.style.display = "none";
      return;
    }
    updateLinkBubble(editor2, bubble);
  },
  addStorage() {
    return {
      bubble: null,
      markdown: {
        serialize: function(state, node) {
          const href = node.attrs.href || "";
          const label = node.attrs.label || href;
          const escapedLabel = state.esc(label);
          const idAttr = node.attrs.id ? `id="${node.attrs.id}"` : "";
          const detectAttr = node.attrs.detect ? `detect="${node.attrs.detect}"` : "";
          const attrs = [idAttr, detectAttr].filter(Boolean).join(" ");
          const attrsSuffix = attrs ? `{${attrs}}` : "";
          const formattedHref = href.includes(" ") ? `<${href}>` : href;
          state.write(`[${escapedLabel}](${formattedHref})${attrsSuffix}`);
        },
        parse: {
          setup: function(markdownit) {
            markdownit.core.ruler.after("inline", "link_attrs", function(state) {
              for (var ti = 0; ti < state.tokens.length; ti++) {
                var token = state.tokens[ti];
                if (token.type !== "inline") continue;
                for (var i = 0; i < token.children.length; i++) {
                  if (token.children[i].type === "link_close") {
                    var next = token.children[i + 1];
                    if (next && next.type === "text" && /^\s*\{/.test(next.content)) {
                      var match = next.content.match(/^\s*\{([^}]+)\}/);
                      if (match) {
                        var attrsStr = match[1];
                        var idM = attrsStr.match(/\bid="([^"]*)"/);
                        var detM = attrsStr.match(/\bdetect="([^"]*)"/);
                        var openToken = token.children[i - 2];
                        if (openToken && openToken.type === "link_open") {
                          if (idM) openToken.attrPush(["data-block-id", idM[1]]);
                          if (detM) openToken.attrPush(["data-detect", detM[1]]);
                        }
                        next.content = next.content.substring(match[0].length);
                      }
                    }
                  }
                }
              }
            });
          },
          tokens: {
            // Map the markdown 'link' tokens to our 'threadLink' node
            link: {
              node: "smartLink",
              getAttrs: (token) => ({
                href: token.attrGet("href"),
                id: token.attrGet("data-block-id"),
                detect: token.attrGet("data-detect"),
                label: token.content
              })
            }
          }
        }
      }
    };
  }
});
function makeBtn(cls, text, onClick) {
  var btn = document.createElement("button");
  btn.className = cls;
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}
function createLinkBubble(currentEditor) {
  var bubble = document.createElement("div");
  bubble.className = "link-bubble";
  bubble.style.cssText = "position:fixed; display:none; z-index:1000; flex-direction:column; gap:8px; padding:12px; border:1px solid #ccc; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); width: 400px;";
  var inputHref = document.createElement("input");
  inputHref.className = "link-bubble__input-href";
  inputHref.placeholder = "URL (https://...)";
  inputHref.style.width = "100%";
  var inputLabel = document.createElement("input");
  inputLabel.className = "link-bubble__input-label";
  inputLabel.placeholder = "Display Text";
  inputLabel.style.width = "100%";
  var saveChanges = function() {
    if (!currentEditor) return;
    currentEditor.chain().focus().updateAttributes("smartLink", {
      href: inputHref.value,
      label: inputLabel.value
    }).run();
  };
  var exit = function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (currentEditor) {
      currentEditor.commands.focus("end");
    }
    bubble.style.display = "none";
  };
  var btnSet = makeBtn("link-bubble__btn", "Set", function() {
    saveChanges();
  });
  var btnRemove = makeBtn("link-bubble__btn link-bubble__btn--remove", "Remove", function() {
    if (!currentEditor) return;
    const attrs = currentEditor.getAttributes("smartLink");
    currentEditor.chain().focus().insertContent(attrs.label || attrs.href).run();
  });
  inputHref.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveChanges();
    }
    if (e.key === "Escape") {
      exit(e);
    }
  });
  inputLabel.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveChanges();
    }
    if (e.key === "Escape") {
      exit(e);
    }
  });
  var hrefRow = document.createElement("div");
  hrefRow.className = "link-bubble__row";
  var hrefLabel = document.createElement("label");
  hrefLabel.textContent = "URL:";
  hrefRow.appendChild(hrefLabel);
  hrefRow.appendChild(inputHref);
  var labelRow = document.createElement("div");
  labelRow.className = "link-bubble__row";
  var labelTitle = document.createElement("label");
  labelTitle.textContent = "Label:";
  labelRow.appendChild(labelTitle);
  labelRow.appendChild(inputLabel);
  var btnRow = document.createElement("div");
  btnRow.className = "link-bubble__actions";
  var btnSet = makeBtn("link-bubble__btn", "Set", function() {
    saveChanges();
  });
  var btnRemove = makeBtn("link-bubble__btn link-bubble__btn--remove", "Remove", function() {
    const attrs = currentEditor.getAttributes("smartLink");
    currentEditor.chain().focus().insertContent(attrs.label || attrs.href).run();
  });
  btnRow.appendChild(btnSet);
  btnRow.appendChild(btnRemove);
  bubble.append(hrefRow, labelRow, btnRow);
  document.body.appendChild(bubble);
  return bubble;
}
function updateLinkBubble(currentEditor, linkBubble) {
  if (!currentEditor || !linkBubble) return;
  if (!currentEditor.isActive("smartLink")) {
    linkBubble.style.display = "none";
    return;
  }
  var attrs = currentEditor.getAttributes("smartLink");
  console.log(currentEditor.getAttributes("smartLink"));
  var inputHref = linkBubble.querySelector(".link-bubble__input-href");
  var inputLabel = linkBubble.querySelector(".link-bubble__input-label");
  inputHref.value = attrs.href || "";
  inputLabel.value = attrs.label || "";
  var from = currentEditor.state.selection.from;
  var coords = currentEditor.view.coordsAtPos(from);
  linkBubble.style.display = "flex";
  linkBubble.style.left = coords.left + "px";
  linkBubble.style.top = coords.bottom + 8 + "px";
  requestAnimationFrame(function() {
    inputHref.focus();
    inputHref.select();
  });
}
T.SmartLink = SmartLink;
