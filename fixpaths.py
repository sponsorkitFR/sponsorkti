import re
from pathlib import Path

base = Path('api/_lib/handlers')
count = 0

for f in base.rglob('*.js'):
    depth = len(f.relative_to(base).parts) - 1  # 0 si directement dans handlers/, 1 si dans un sous-dossier
    prefix = '../' * (depth + 1)  # +1 pour remonter jusqu'a api/_lib/

    text = f.read_text(encoding='utf-8')
    def repl(m):
        return f"{m.group(1)}{prefix}{m.group(3)}{m.group(1)}"
    new_text, n = re.subn(r"""(['"])(\.\./|\./)*_lib/([^'"]+)\1""", repl, text)
    if n > 0:
        f.write_text(new_text, encoding='utf-8')
        count += n
        print(f"{f}: {n} import(s) corrige(s)")

print(f"TOTAL: {count} corrections")
