const { Editor } = require('@tiptap/core');
const { Markdown } = require('tiptap-markdown');
const Link = require('@tiptap/extension-link').default;

console.log('Markdown includes:', Markdown.config.addExtensions ? Markdown.config.addExtensions().map(e => e.name) : 'none');
