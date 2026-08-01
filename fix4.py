with open('public/index.html') as f:
    content = f.read()
old_snippet = "alert('RAW: ' + (raw ? raw.substring(0,300) : 'VIDE'));"
new_snippet = "prompt('Copie ce texte (Ctrl+C) puis OK:', raw || 'VIDE');"
if old_snippet in content:
    content = content.replace(old_snippet, new_snippet)
    print('Remplacement fait')
else:
    print('ATTENTION: motif non trouve, verifier manuellement')
with open('public/index.html', 'w') as f:
    f.write(content)
