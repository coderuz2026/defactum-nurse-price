import openpyxl, sys, re, json, collections
src, out = sys.argv[1], sys.argv[2]
rows = list(openpyxl.load_workbook(src, read_only=True, data_only=True).active.iter_rows(values_only=True))[1:]
cats, items, excluded, seen = {}, [], [], set()
for ext, name, cat, _n, price, _c in rows:
    name = re.sub(r'\s+', ' ', (name or '')).strip()
    cat = re.sub(r'\s+', ' ', (cat or '')).strip()
    reason = None
    if not price: reason = 'цена 0'
    elif re.match(r'(?i)uzairways', name): reason = 'корпоративный (UzAirways)'
    elif re.search(r'(?i)льгота|по абонементу', name): reason = 'льгота/абонемент'
    elif name.lower() in seen: reason = 'дубль'
    if reason:
        excluded.append({'name': name, 'category': cat, 'price': price or 0, 'reason': reason}); continue
    seen.add(name.lower())
    m = re.match(r'^(\d+(?:/\d+)?)\.\s*(.*)$', cat)
    code, cname = (m.group(1), m.group(2)) if m else ('', 'Прочее' if cat == 'All' else cat)
    if cname not in cats: cats[cname] = {'id': len(cats) + 1, 'code': code, 'name': cname}
    pid = re.search(r'product_product_(\d+)', ext or '')
    items.append({'id': int(pid.group(1)) if pid else None, 'name': name, 'cat': cats[cname]['id'], 'price': int(price)})
items.sort(key=lambda x: (x['cat'], x['name'].lower()))
data = {'version': '2026-11-10', 'currency': 'UZS', 'source': 'Aurora: экспорт product.product',
        'categories': sorted(cats.values(), key=lambda c: (c['code'] == '', [int(p) for p in c['code'].split('/')] if c['code'] else [999], c['name'])),
        'items': items}
json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump(excluded, open(out.replace('.json', '_excluded.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('items', len(items), 'cats', len(cats), 'excluded', len(excluded), collections.Counter(e['reason'] for e in excluded))
