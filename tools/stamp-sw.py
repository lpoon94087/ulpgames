#!/usr/bin/env python3
"""Write sw.js's FILES (every file the site serves) and VERSION (a hash of them).

Run from anywhere; the pre-commit hook runs it and stages sw.js. A page is listed by its folder
("madgab/"), since that's the address people open. Codenames' pictures (codenames/img/) are left
out: they're large, so they're saved when a board first shows them rather than on every visit."""
import hashlib, json, pathlib, re, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVED = re.compile(r'^(index\.html|(shared|madgab|watch-ya-mouth|word-generator|password|codenames|one-word)/.+)$')
tracked = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
files = sorted(f for f in set(tracked) if SERVED.match(f) and not f.startswith('codenames/img/') and (ROOT / f).exists())
h = hashlib.sha256()
for f in files:
    h.update(f.encode()); h.update((ROOT / f).read_bytes())
urls = ['' if f == 'index.html' else f[:-len('index.html')] if f.endswith('/index.html') else f for f in files]
sw = ROOT / 'sw.js'
src = sw.read_text()
src = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{h.hexdigest()[:12]}';", src)
src = re.sub(r"const FILES = \[.*?\];", 'const FILES = ' + json.dumps(urls, indent=2).replace('"', "'") + ';', src, flags=re.S)
sw.write_text(src)
print(f'sw.js: {len(urls)} files, version {h.hexdigest()[:12]}')
