with open('public/index.html', encoding='utf-8') as f:
    content = f.read()

old = "const skAuth = supabase.createClient('https://uinynydhksabcnrglevx.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbnlucGRoa3NhYmNucmdsZXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0ImFub24iLCJpYXQiOjE.hNQc9__c9llxvBe8XJZ-0erse6dl-ZXXA47SkY4ukw');let currentUser = null;"

new = "const skAuth = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);\nlet currentUser = null;"

if old in content:
    content = content.replace(old, new, 1)
    print('Remplacement OK (methode exacte)')
else:
    # Methode de secours : regex plus permissive
    import re
    pattern = re.compile(r"const skAuth = supabase\.createClient\('https://uinynydhksabcnrglevx\.supabase\.co', '[^']+'\);let currentUser = null;")
    new_content, n = pattern.subn(new, content)
    if n > 0:
        content = new_content
        print(f'Remplacement OK (methode regex), {n} occurrence(s)')
    else:
        print('ECHEC: aucune methode n a fonctionne')

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(content)
