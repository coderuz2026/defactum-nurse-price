/* Связь с Aurora (МИС клиники) прямо с телефона медсестры — пилотный режим, без сервера-моста.
   Aurora работает на Odoo: вход и запросы идут по JSON-RPC (/web/session/authenticate, /web/dataset/call_kw).
   Логин и пароль вводятся на телефоне и хранятся только на нём; в коде и в репозитории их нет.
   Приложение только читает данные, в Aurora ничего не меняет.
   В APK запросы идут через родной HTTP (CapacitorHttp) — у браузера внутри WebView такие запросы запрещены (CORS). */
(function (root) {
  'use strict';
  const CH = () => root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.CapacitorHttp;
  const base = (cfg) => String(cfg.url || '').trim().replace(/\/+$/, '');
  let sess = null; // { key, cookie, uid, name, version }
  const keyOf = (cfg) => [base(cfg), cfg.db, cfg.login, cfg.password].join('|');

  class AuroraError extends Error { constructor(msg, kind) { super(msg); this.kind = kind || 'error'; } }

  // Один POST с JSON. Возвращает { status, data, cookie }.
  async function post(url, body, cookie) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (CH()) {
      let r;
      try { r = await CH().request({ url, method: 'POST', headers, data: body, connectTimeout: 15000, readTimeout: 30000, responseType: 'json' }); }
      catch (e) { throw new AuroraError('Нет связи с Aurora. Проверьте интернет и адрес.', 'net'); }
      let data = r.data; if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
      let sc = ''; Object.keys(r.headers || {}).forEach((k) => { if (k.toLowerCase() === 'set-cookie') sc = String(r.headers[k]); });
      const m = sc.match(/session_id=([^;,\s]+)/);
      return { status: r.status, data, cookie: m ? 'session_id=' + m[1] : '' };
    }
    let r;
    try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' }); }
    catch (e) { throw new AuroraError('Нет связи с Aurora. С сайта запросы запрещены браузером — откройте приложение (APK).', 'net'); }
    let data = null; try { data = await r.json(); } catch (e) { /* не JSON */ }
    return { status: r.status, data, cookie: '' };
  }

  async function rpc(cfg, path, params, cookie) {
    const r = await post(base(cfg) + path, { jsonrpc: '2.0', method: 'call', params: params || {}, id: Date.now() }, cookie);
    if (r.status === 404) throw new AuroraError('По этому адресу Aurora не отвечает (404). Проверьте адрес.', 'url');
    if (!r.data) throw new AuroraError('Aurora ответила непонятно (код ' + r.status + '). Проверьте адрес.', 'url');
    if (r.data.error) {
      const d = r.data.error.data || {}, name = String(d.name || ''), msg = String(d.message || r.data.error.message || 'Ошибка Aurora');
      if (/SessionExpired/i.test(name) || r.data.error.code === 100) throw new AuroraError('Сеанс Aurora истёк', 'session');
      if (/AccessDenied/i.test(name)) throw new AuroraError('Aurora отклонила вход: неверный логин или пароль', 'auth');
      if (/AccessError/i.test(name)) throw new AuroraError('У этой учётной записи нет доступа: ' + msg.split('\n')[0], 'access');
      throw new AuroraError(msg.split('\n')[0], 'server');
    }
    return { result: r.data.result, cookie: r.cookie };
  }

  // Что за сервер и какие на нём базы — без входа. Нужно, чтобы при ошибке входа было видно причину.
  async function probe(cfg) {
    const info = { version: '', dbs: null, raw: '' };
    try { const r = await rpc(cfg, '/web/webclient/version_info', {}); info.version = (r.result && r.result.server_version) || ''; }
    catch (e) { info.raw = 'версия: ' + e.message; }
    try { const r = await rpc(cfg, '/web/database/list', {}); if (Array.isArray(r.result)) info.dbs = r.result; }
    catch (e) { /* список баз закрыт — это нормально */ }
    return info;
  }
  async function login(cfg) {
    if (!base(cfg) || !cfg.login || !cfg.password) throw new AuroraError('Заполните адрес, логин и пароль Aurora', 'cfg');
    let r;
    try { r = await rpc(cfg, '/web/session/authenticate', { db: cfg.db || '', login: cfg.login, password: cfg.password }); }
    catch (e) {
      if (e.kind === 'net') throw e;
      const p = await probe(cfg).catch(() => ({}));
      const extra = [p.version ? 'сервер Odoo ' + p.version : 'сервер не похож на Aurora/Odoo', p.dbs ? 'базы: ' + (p.dbs.join(', ') || 'нет') : 'список баз закрыт'].join(' · ');
      const hint = p.dbs && p.dbs.length && p.dbs.indexOf(cfg.db) < 0 ? ' Базы «' + cfg.db + '» на сервере нет — впишите одну из списка.' : '';
      throw new AuroraError(e.message + '.' + hint + ' [' + extra + ']', e.kind);
    }
    const s = r.result || {};
    if (!s.uid) {
      const p = await probe(cfg).catch(() => ({}));
      throw new AuroraError('Aurora не впустила: сервер ответил без пользователя. Возможно, у учётной записи включён вход по коду (двухфакторный) или нужен другой логин. [' + (p.version ? 'Odoo ' + p.version : 'версия неизвестна') + (p.dbs ? ' · базы: ' + p.dbs.join(', ') : '') + ']', 'auth');
    }
    sess = { key: keyOf(cfg), cookie: r.cookie, uid: s.uid, name: s.name || s.username || cfg.login, version: s.server_version || '', db: s.db || cfg.db || '' };
    return sess;
  }
  async function ensure(cfg) { return sess && sess.key === keyOf(cfg) ? sess : login(cfg); }

  // Вызов метода модели (только чтение: search_read, read, search_count, fields_get)
  async function call(cfg, model, method, args, kwargs) {
    for (let attempt = 0; ; attempt++) {
      const s = await ensure(cfg);
      try {
        const r = await rpc(cfg, '/web/dataset/call_kw/' + model + '/' + method, { model, method, args: args || [], kwargs: kwargs || {} }, s.cookie);
        return r.result;
      } catch (e) {
        if (e.kind === 'session' && attempt === 0) { sess = null; continue; } // сеанс истёк — входим заново один раз
        throw e;
      }
    }
  }
  const logout = () => { sess = null; };

  /* ---- Отчёт для настройки: как в этой Aurora называются таблицы и поля пациентов, заказов и анализов.
     В отчёт попадают только НАЗВАНИЯ таблиц и полей и количество записей. Значения (ФИО, телефоны, анализы) не попадают:
     вместо значения пишется только его вид («текст 12 симв.», «число», «ссылка → таблица»). ---- */
  const KEY = /patient|пациент|order|заказ|заявк|lab|анализ|analy|service|услуг|home|вызов|выезд|invoice|счет|счёт|sale|partner|tube|пробир|contain|контейнер|biomat|биомат|sample|проб|visit|визит|appoint|запис|medical|med\.|brigad|бригад|price|прайс|product|номенклат/i;
  const STD = /^(ir|base|bus|web|mail|report|digest|resource|uom|utm|iap|sms|snailmail|auth|portal|rating|website|payment|fetchmail|barcodes|phone|google|microsoft|web_editor|web_tour|privacy|onboarding|format|change|decimal|res\.(config|lang|currency|country|bank|groups|users\.(log|apikeys|deletion|identitycheck|settings)))\b/;
  const shape = (v, f) => {
    if (v === false || v === null || v === undefined || v === '') return 'пусто';
    if (Array.isArray(v)) return f && (f.type === 'many2one') ? 'ссылка → ' + f.relation : 'список (' + v.length + ')' + (f && f.relation ? ' → ' + f.relation : '');
    if (typeof v === 'number') return 'число';
    if (typeof v === 'boolean') return 'да/нет';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'дата';
    if (/^[\d\s+()-]{7,}$/.test(s)) return 'цифры ' + s.replace(/\D/g, '').length + ' зн.';
    return 'текст ' + s.length + ' симв.';
  };

  async function discover(cfg, testId, say) {
    say = say || (() => {});
    const out = [], P = (s) => out.push(s);
    say('Вход в Aurora…');
    const s = await login(cfg);
    P('ОТЧЁТ ДЛЯ НАСТРОЙКИ AURORA (без данных пациентов)');
    P('Версия сервера: ' + s.version + ' · база: ' + s.db + ' · пользователь №' + s.uid);
    say('Список таблиц…');
    let models = [];
    try { models = await call(cfg, 'ir.model', 'search_read', [[['transient', '=', false]]], { fields: ['model', 'name'], limit: 3000 }); }
    catch (e) { P('Список таблиц недоступен: ' + e.message); }
    const custom = models.filter((m) => !STD.test(m.model));
    const cand = custom.filter((m) => KEY.test(m.model) || KEY.test(m.name)).slice(0, 70);
    P('Всего таблиц: ' + models.length + ', из них нестандартных: ' + custom.length);
    P(''); P('== ВСЕ НЕСТАНДАРТНЫЕ ТАБЛИЦЫ =='); custom.forEach((m) => P(m.model + ' — ' + m.name));
    const fieldsOf = {}; let k = 0;
    P(''); P('== ПОЛЯ ТАБЛИЦ-КАНДИДАТОВ ==');
    for (const m of cand) {
      say('Поля таблиц: ' + (++k) + ' из ' + cand.length);
      try {
        const [fg, cnt] = await Promise.all([call(cfg, m.model, 'fields_get', [], { attributes: ['string', 'type', 'relation', 'store'] }), call(cfg, m.model, 'search_count', [[]]).catch(() => '?')]);
        fieldsOf[m.model] = fg;
        P(''); P('# ' + m.model + ' — ' + m.name + ' · записей: ' + cnt);
        Object.keys(fg).filter((f) => !/^(__last_update|create_uid|write_uid|write_date|message_|activity_|website_message|access_|display_name$)/.test(f))
          .forEach((f) => P('  ' + f + ' [' + fg[f].type + (fg[f].relation ? ' → ' + fg[f].relation : '') + '] ' + fg[f].string));
      } catch (e) { P(''); P('# ' + m.model + ' — нет доступа: ' + e.message); }
    }
    const id = String(testId || '').replace(/\D/g, '');
    if (id) {
      P(''); P('== ГДЕ НАХОДИТСЯ ПРОВЕРОЧНЫЙ ID (сам номер и данные не показаны) ==');
      const hits = []; k = 0;
      for (const m of cand) {
        say('Поиск ID по таблицам: ' + (++k) + ' из ' + cand.length);
        const fg = fieldsOf[m.model]; if (!fg) continue;
        const tries = [['id', +id]];
        Object.keys(fg).forEach((f) => {
          if (fg[f].store === false) return;
          if (fg[f].type === 'char' && /code|ref|number|num|name|card|uid|barcode|ident|номер|код/i.test(f + ' ' + fg[f].string)) tries.push([f, id]);
          if (fg[f].type === 'integer' && /code|ref|number|num|card|ident|номер|код/i.test(f + ' ' + fg[f].string)) tries.push([f, +id]);
        });
        for (const [f, v] of tries.slice(0, 14)) {
          try {
            const rec = await call(cfg, m.model, 'search_read', [[[f, '=', v]]], { limit: 1 });
            if (rec && rec.length) {
              hits.push({ model: m.model, rid: rec[0].id });
              P(''); P('# найден в ' + m.model + ' по полю «' + f + '». Заполненные поля записи:');
              Object.keys(rec[0]).forEach((x) => { const sh = shape(rec[0][x], fg[x]); if (sh !== 'пусто' && fg[x] && !/^(message_|activity_|__)/.test(x)) P('  ' + x + ': ' + sh); });
            }
          } catch (e) { /* поле не ищется — пропускаем */ }
        }
      }
      if (!hits.length) P('Нигде не найден. Проверьте ID или права учётной записи.');
      // Что ссылается на найденные записи (заказы, вызовы, счета пациента)
      for (const h of hits.slice(0, 4)) {
        P(''); P('# Кто ссылается на ' + h.model + ':');
        for (const m of cand) {
          const fg = fieldsOf[m.model]; if (!fg) continue;
          for (const f of Object.keys(fg)) {
            if (fg[f].type !== 'many2one' || fg[f].relation !== h.model || fg[f].store === false) continue;
            try { const c = await call(cfg, m.model, 'search_count', [[[f, '=', h.rid]]]); if (c) P('  ' + m.model + '.' + f + ' («' + fg[f].string + '») — записей: ' + c); } catch (e) { /* нет доступа */ }
          }
        }
      }
    }
    say('Готово');
    return out.join('\n');
  }

  const api = { login, call, logout, discover, AuroraError, _shape: shape };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Aurora = api;
})(typeof window !== 'undefined' ? window : globalThis);
