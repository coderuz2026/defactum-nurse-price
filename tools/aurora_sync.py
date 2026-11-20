#!/usr/bin/env python3
"""Синхронизация прайса медсестёр с Aurora: цены и пробирки («анализ → контейнер»).

Запускается по расписанию в GitHub Actions (.github/workflows/aurora-sync.yml).
Читает из Aurora только справочники — услуги, цены, контейнеры, связь «услуга → контейнер».
Данных пациентов не читает и не пишет. В Aurora ничего не меняет.

Переменные окружения: AURORA_URL, AURORA_DB, AURORA_LOGIN, AURORA_PASSWORD.
Файл: data/prices.json (пишется, только если что-то изменилось).
"""
import datetime
import http.cookiejar
import json
import os
import re
import sys
import urllib.request

PRICES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'prices.json')


class Aurora:
    def __init__(self, url, db, login, password):
        self.url = url.rstrip('/')
        self.db, self.login, self.password = db, login, password
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def rpc(self, path, params):
        body = json.dumps({'jsonrpc': '2.0', 'method': 'call', 'params': params, 'id': 1}).encode()
        req = urllib.request.Request(self.url + path, body, {'Content-Type': 'application/json'})
        with self.op.open(req, timeout=90) as r:
            data = json.loads(r.read().decode())
        if data.get('error'):
            err = data['error']
            msg = (err.get('data') or {}).get('message') or err.get('message') or 'ошибка Aurora'
            raise RuntimeError(str(msg).split('\n')[0])
        return data.get('result')

    def connect(self):
        res = self.rpc('/web/session/authenticate', {'db': self.db, 'login': self.login, 'password': self.password}) or {}
        if not res.get('uid'):
            raise RuntimeError('Aurora не впустила: проверьте AURORA_LOGIN и AURORA_PASSWORD')
        return res

    def call(self, model, method, args, kw=None):
        return self.rpc('/web/dataset/call_kw/%s/%s' % (model, method), {'model': model, 'method': method, 'args': args, 'kwargs': kw or {}})


def norm(s):
    s = re.sub(r'^\[[^\]]*\]\s*', '', str(s or '')).lower().replace('ё', 'е')
    return re.sub(r'[^a-zа-я0-9]', '', s)


def m2o(v):
    return v[0] if isinstance(v, list) and v else 0


def cont_no(c):
    """Номер контейнера — как на листе заказа и этикетке (поле «код» и т. п.)."""
    for v in (c.get('code'), c.get('container_id'), c.get('short_name')):
        if isinstance(v, list):
            v = v[1] if len(v) > 1 else ''
        m = re.match(r'^0*(\d{1,3})$', str(v or '').strip())
        if m:
            return int(m.group(1))
    return 0


def main():
    env = {k: os.environ.get(k, '').strip() for k in ('AURORA_URL', 'AURORA_DB', 'AURORA_LOGIN', 'AURORA_PASSWORD')}
    if not env['AURORA_LOGIN'] or not env['AURORA_PASSWORD']:
        sys.exit('Не заданы секреты AURORA_LOGIN и AURORA_PASSWORD (Settings → Secrets and variables → Actions)')
    a = Aurora(env['AURORA_URL'] or 'https://mis.defactum.uz', env['AURORA_DB'] or 'aurora', env['AURORA_LOGIN'], env['AURORA_PASSWORD'])
    s = a.connect()
    print('Вход в Aurora: %s, Odoo %s' % (s.get('db'), s.get('server_version')))

    d = json.load(open(PRICES, encoding='utf-8'))
    items = d['items']
    names = sorted({it['name'] for it in items})

    conts = a.call('lis.container', 'search_read', [[]], {'fields': ['name', 'code', 'short_name', 'color', 'container_id'], 'limit': 1000})
    maps = a.call('lis.biomaterial_container_map', 'search_read', [[]], {'fields': ['product_id', 'bio_material_id', 'container_id'], 'limit': 50000})
    ids = sorted({m2o(m['product_id']) for m in maps if m2o(m['product_id'])} | {it['id'] for it in items})
    prods = a.call('product.product', 'search_read', [['|', ['id', 'in', ids], ['name', 'in', names]]], {'fields': ['name', 'lst_price', 'active'], 'limit': 50000})
    print('Контейнеров: %d, связей «услуга → контейнер»: %d, услуг: %d' % (len(conts), len(maps), len(prods)))
    if not conts or not maps:
        sys.exit('Aurora вернула пустой справочник контейнеров — прайс не трогаю')

    cont = {c['id']: c for c in conts}
    tubes, mats = {}, {}
    for m in maps:
        pid, cid = m2o(m['product_id']), m2o(m['container_id'])
        if not pid or not cid:
            continue
        tubes.setdefault(pid, [])
        if cid not in tubes[pid]:
            tubes[pid].append(cid)
        mat = m['bio_material_id'][1] if isinstance(m['bio_material_id'], list) else ''
        if mat and cid not in mats:
            mats[cid] = mat
    prod = {p['id']: p for p in prods}
    by_name = {}
    for p in prods:
        by_name.setdefault(norm(p['name']), []).append(p['id'])

    out_items, used, price_ch, tube_ch = {}, set(), [], 0
    old_tubes = (d.get('auTubes') or {}).get('items', {})
    for it in items:
        cands = [it['id']] + [x for x in by_name.get(norm(it['name']), []) if x != it['id']]
        for pid in cands:  # сначала сама услуга прайса, потом услуги Aurora с тем же названием
            if tubes.get(pid):
                cids = [c for c in tubes[pid] if cont_no(cont.get(c, {}))]
                if cids:
                    out_items[str(it['id'])] = cids
                    used.update(cids)
                break
        if out_items.get(str(it['id'])) != old_tubes.get(str(it['id'])):
            tube_ch += 1
        # цена: у самой услуги, иначе одна общая у всех услуг с тем же названием
        p = prod.get(it['id'])
        new = round(p['lst_price']) if p and p.get('lst_price') else None
        if new is None:
            ps = {round(prod[x]['lst_price']) for x in by_name.get(norm(it['name']), []) if prod[x].get('lst_price')}
            new = ps.pop() if len(ps) == 1 else None
        if new and new != it['price']:
            price_ch.append('%s: %s → %s' % (it['name'][:60], it['price'], new))
            it['price'] = new

    def color(c):
        v = str(cont[c].get('color') or '')
        return v if re.match(r'^#[0-9a-fA-F]{6}$', v) else ''
    au = {'v': 1, 'cont': {str(c): {'no': cont_no(cont[c]), 'name': cont[c].get('name') or '', 'color': color(c), 'mat': mats.get(c, '')} for c in sorted(used)},
          'items': out_items}
    changed = bool(price_ch) or tube_ch > 0 or (d.get('auTubes') or {}).get('cont') != au['cont']
    print('Анализов с пробиркой из Aurora: %d из %d' % (len(out_items), len(items)))
    print('Изменилось цен: %d, пробирок: %d' % (len(price_ch), tube_ch))
    for line in price_ch[:200]:
        print('  цена ' + line)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write('### Синхронизация с Aurora\n\n- анализов с пробиркой из Aurora: %d из %d\n- изменилось цен: %d\n- изменилось пробирок: %d\n' % (len(out_items), len(items), len(price_ch), tube_ch))
            for line in price_ch[:100]:
                f.write('  - %s\n' % line)
    if not changed:
        print('Ничего не изменилось')
        return
    d['auTubes'] = au
    d['version'] = datetime.date.today().isoformat()
    d['source'] = 'Aurora: цены и пробирки, синхронизация %s' % datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    with open(PRICES, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('data/prices.json обновлён')


if __name__ == '__main__':
    main()
