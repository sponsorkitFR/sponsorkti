with open('public/index.html') as f:
    content = f.read()
old = "  sb.auth.onAuthStateChange((event, session) => {\n    if (event === 'SIGNED_OUT') { window.location.href = '/login.html'; return; }\n    if (session) userToken = session.access_token;\n  });"
new = "  sb.auth.onAuthStateChange((event, session) => {\n    alert('EVENT: ' + event);\n    if (session) userToken = session.access_token;\n  });"
content = content.replace(old, new, 1)
with open('public/index.html', 'w') as f:
    f.write(content)
print('OK' if old in open('public/index.html').read().replace(new, old) else 'ATTENTION: motif non trouvé')
