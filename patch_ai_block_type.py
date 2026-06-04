import re
with open('frontend/src/static/editor.js', 'r') as f:
    content = f.read()

content = content.replace("type: 'aiBlock',", "type: 'sieve-ai-block',")

with open('frontend/src/static/editor.js', 'w') as f:
    f.write(content)
