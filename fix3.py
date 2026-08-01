with open('public/index.html') as f:
    content = f.read()
old = "  const { data: { session } } = await sb.auth.getSession();"
new = "  const { data: { session }, error: sessErr } = await sb.auth.getSession();\n  alert('session existe: ' + (session ? 'OUI' : 'NON') + ' | erreur: ' + (sessErr ? sessErr.message : 'aucune') + ' | expires_at: ' + (session ? session.expires_at : 'N/A') + ' | maintenant: ' + Math.floor(Date.now()/1000));"
content = content.replace(old, new, 1)
with open('public/index.html', 'w') as f:
    f.write(content)
print('OK')
