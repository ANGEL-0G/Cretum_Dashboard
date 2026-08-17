"""Reemplaza la seccion #estructura existente del bundle por la nueva version del
draft (con layout movil). Mismas claves t (ya inyectadas). Valida round-trip."""
import json, re, shutil

CANON = "/Users/air/cretum_dashboard_coworker/public/gvv-detalle.html"
DRAFT = "/Users/air/cretum_dashboard_coworker/_tools_gvv/estructura_draft.html"
URIS = "/Users/air/cretum_dashboard_coworker/_tools_gvv/uris.json"

d = open(DRAFT).read()
sec = d[d.find('<section id="estructura"'):d.find('</section>') + len('</section>')]
uris = json.load(open(URIS))
for k, v in uris.items():
    sec = sec.replace('{{' + k + '}}', v)
assert '{{' not in sec.replace('{{ t.', '§'), "placeholder sin resolver"

# mismos reemplazos bilingues que la inyeccion original
REPL = [
    ('>Estructura</h3>', '>{{ t.est_eyebrow }}</h3>'),
    ('>Estructura del Fondo</div>', '>{{ t.est_title }}</div>'),
    ('>Gobernanza institucional: custodio global, administrador independiente y auditoría externa.</p>',
     '>{{ t.est_sub }}</p>'),
    ('>INVERSIONISTA</div>', '>{{ t.est_investor }}</div>'),
    ('>Preparado por NAV Consulting</div>', '>{{ t.est_stmt2 }}</div>'),
    ('>(Custodio USA)</div>', '>{{ t.est_cust }}</div>'),
    ('>Ontario, Canadá</div>', '>{{ t.est_loc }}</div>'),
    ('>Inversiones y efectivo</div>', '>{{ t.est_cash }}</div>'),
    ('>Transferencia de fondos</div>', '>{{ t.est_transfer }}</div>'),
    ('>Gestión de inversiones y supervisión</div>', '>{{ t.est_mgmt }}</div>'),
    ('>Estados de cuenta</div>', '>{{ t.est_stmts }}</div>'),
    ('>Proveedores</div>', '>{{ t.est_provs }}</div>'),
    # version movil (spans en vez de divs para tags, y cards duplicadas)
    ('>Transferencia de fondos</span>', '>{{ t.est_transfer }}</span>'),
    ('>Gestión de inversiones y supervisión</span>', '>{{ t.est_mgmt }}</span>'),
    ('>Estados de cuenta</span>', '>{{ t.est_stmts }}</span>'),
]
for old, new in REPL:
    if old in sec:
        sec = sec.replace(old, new)
for extra in ('>INVERSIONISTA<', '>(Custodio USA)<', '>Ontario, Canadá<', '>Inversiones y efectivo<',
              '>Investment Statement<', '>Preparado por NAV Consulting<'):
    # segunda pasada para las duplicadas del bloque movil
    key = {'>INVERSIONISTA<': 'est_investor', '>(Custodio USA)<': 'est_cust',
           '>Ontario, Canadá<': 'est_loc', '>Inversiones y efectivo<': 'est_cash',
           '>Preparado por NAV Consulting<': 'est_stmt2'}.get(extra)
    if key and extra in sec:
        sec = sec.replace(extra, '>{{ t.%s }}<' % key)

src = open(CANON).read()
shutil.copy(CANON, "/tmp/gvv_pre_mobile.html")

def esc(s):
    return json.dumps(s, ensure_ascii=True)[1:-1].replace("/", "\\u002f")

start = src.find('<section id=\\"estructura\\"')
assert start > 0, "seccion no encontrada en el bundle"
end_marker = '<\\u002fsection>'
end = src.find(end_marker, start) + len(end_marker)
src = src[:start] + esc(sec) + src[end:]

ms = re.search(r'<script type="__bundler/template">', src)
tpl = src[ms.end():]
tpl = tpl[:tpl.find("</script>")]
dec = json.loads(tpl)
assert dec.count('id="estructura"') == 1
assert 'est-mobile' in dec and 'est-m-card' in dec
open(CANON, "w").write(src)
print("seccion reemplazada con version movil. bytes:", len(src))
