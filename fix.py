with open('public/index.html') as f:
    content = f.read()
old = "  if (!session) {"
new = "  try { const raw = localStorage.getItem('sb-dqwzlgudjvuvakhzwgru-auth-token'); alert('RAW: ' + (raw ? raw.substring(0,300) : 'VIDE')); } catch(e) { alert('Erreur lecture: ' + e.message); }\n  if (!session) {"
content = content.replace(old, new, 1)
with open('public/index.html', 'w') as f:
    f.write(content)
print('OK')
