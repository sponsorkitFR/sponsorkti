with open('public/index.html', encoding='utf-8') as f:
    content = f.read()

old = """(async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }
  currentUser = session.user;
  userToken = session.access_token;
"""

new = """(async function init() {
  const raw = localStorage.getItem('sb-dqwzlgudjvuvakhzwgru-auth-token');
  let parseOk = 'N/A';
  if (raw) { try { JSON.parse(raw); parseOk = 'JSON valide'; } catch(e) { parseOk = 'JSON CASSE: ' + e.message; } }
  alert('Longueur stockee: ' + (raw ? raw.length : 0) + ' caracteres | ' + parseOk);
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }
  currentUser = session.user;
  userToken = session.access_token;
"""

if old in content:
    content = content.replace(old, new, 1)
    print('Remplacement OK')
else:
    print('MOTIF NON TROUVE')

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(content)
