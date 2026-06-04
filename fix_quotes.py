import re
with open('frontend/src/static/editor.js', 'r') as f:
    content = f.read()

content = content.replace("question: question || ',", "question: question || '',")

with open('frontend/src/static/editor.js', 'w') as f:
    f.write(content)
