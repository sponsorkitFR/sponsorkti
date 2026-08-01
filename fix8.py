with open('public/index.html', encoding='utf-8') as f:
    content = f.read()

old = """(async function init() {
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

new = """(async function init() {
  let session = null;
  for (let i = 0; i < 3 && !session; i++) {
    const res = await sb.auth.getSession();
    session = res.data.session;
    if (!session) await new Promise(r => setTimeout(r, 300));
  }
  if (!session) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;font-family:sans-serif;color:#e8e8f5;background:#07070d;"><p>Session introuvable.</p><a href="/login.html" style="background:#6c5ce7;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">Se connecter</a></div>';
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
