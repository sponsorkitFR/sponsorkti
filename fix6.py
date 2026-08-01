with open('public/login.html', encoding='utf-8') as f:
    content = f.read()

old = """// ── AUTO-REDIRECT si déjà connecté ────────────────────────────────────────
sb.auth.getSession().then(({ data: { session } }) => {
  if (session) window.location.href = '/';
});
"""

new = """// ── AUTO-REDIRECT si déjà connecté ────────────────────────────────────────
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' && session) window.location.href = '/';
});
"""

if old in content:
    content = content.replace(old, new, 1)
    print('Remplacement OK')
else:
    print('MOTIF NON TROUVE')

with open('public/login.html', 'w', encoding='utf-8') as f:
    f.write(content)
