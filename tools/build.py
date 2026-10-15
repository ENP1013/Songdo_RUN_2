"""src/app.html + src/engine.js + src/leaflet.css + data/songdo.json → index.html (단일 파일)"""
import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
rd = lambda *p: open(os.path.join(ROOT, *p), encoding="utf-8").read()
html = rd("src", "app.html")
data = rd("data", "songdo.json")
assert "</script" not in data
html = (html.replace("/*__LEAFLET_CSS__*/", rd("src", "leaflet.css"))
            .replace("/*__ENGINE__*/", rd("src", "engine.js"))
            .replace("__SONGDO_DATA__", data))
open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8").write(html)
print(f"index.html {len(html.encode('utf-8')) // 1024} KB")

# 일반 호스팅(Vercel·GitHub Pages·Netlify)용: 문서 골격을 붙인 docs/index.html (GitHub Pages는 /docs 폴더를 서비스)
os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
skeleton = ('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
            'body{margin:0}img{max-width:100%}</style></head><body>')
open(os.path.join(ROOT, "docs", "index.html"), "w", encoding="utf-8").write(skeleton + html + "</body></html>")
print("docs/index.html written")
