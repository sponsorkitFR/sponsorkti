import re

with open('public/index.html', encoding='utf-8') as f:
    content = f.read()

pattern = re.compile(
    r"\(async function init\(\) \{\n"
    r"  // 1\. Auth guard.*?\n"
    r"  const \{ data: \{ session \}, error: sessErr \} = await sb\.auth\.getSession\(\);\n"
    r".*?\n"
    r".*?\n"
    r"  if \(!session\) \{\n"
    r"    window\.location\.href = '/login\.html';\n"
    r"    return;\n"
    r"  \}\n"
    r"  currentUser = session\.user;\n"
    r"  userToken = session\.access_token;\n"
    r"\n"
    r"  // Refresh token automatique\n"
    r"  sb\.auth\.onAuthStateChange\(\(event, session\) => \{\n"
    r"    alert\('EVENT: ' \+ event\);\n"
    r"    if \(session\) userToken = session\.access_token;\n"
    r"  \}\);\n",
    re.DOTALL
)

replacement = """let initDone = false;
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { window.location.href = '/login.html'; return; }
  if (session) userToken = session.access_token;
});

(async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }
  currentUser = session.user;
  userToken = session.access_token;
"""

new_content, n = pattern.subn(replacement, content)
print(f"Remplacements effectues: {n}")

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(new_content)
