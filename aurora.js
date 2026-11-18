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
      if (/AccessDenied/i.test(name)) throw new AuroraError('Aurora отклонила вход: ' + (/^access denied$/i.test(msg.trim()) ? 'неверный логин или пароль' : msg.split('\n')[0]), 'auth');
      if (/AccessError/i.test(name)) throw new AuroraError('У этой учётной записи нет доступа: ' + msg.split('\n')[0], 'access');
      throw new AuroraError(msg.split('\n')[0], 'server');
    }
    return { result: r.data.result, cookie: r.cookie };
  }

  // Запрос «как браузер»: страница или форма. Возвращает { status, text, cookie }.
  async function raw(method, url, form, cookie) {
    const headers = {}; if (cookie) headers.Cookie = cookie;
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = Object.keys(form).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&'); }
    if (CH()) {
      let r;
      try { r = await CH().request({ url, method, headers, data: body, connectTimeout: 15000, readTimeout: 30000, responseType: 'text', disableRedirects: true }); }
      catch (e) { throw new AuroraError('Нет связи с Aurora. Проверьте интернет и адрес.', 'net'); }
      let sc = ''; Object.keys(r.headers || {}).forEach((k) => { if (k.toLowerCase() === 'set-cookie') sc = String(r.headers[k]); });
      const all = sc.match(/session_id=([^;,\s]+)/g) || [];
      let loc = ''; Object.keys(r.headers || {}).forEach((k) => { if (k.toLowerCase() === 'location') loc = String(r.headers[k]); });
      return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data || ''), cookie: all.length ? all[all.length - 1] : '', location: loc };
    }
    let r;
    try { r = await fetch(url, { method, headers: form ? { 'Content-Type': headers['Content-Type'] } : {}, body, credentials: 'include', redirect: form ? 'manual' : 'follow' }); }
    catch (e) { throw new AuroraError('Нет связи с Aurora.', 'net'); }
    return { status: r.status || 303, text: r.type === 'opaqueredirect' ? '' : await r.text().catch(() => ''), cookie: '', location: '', finalUrl: r.url };
  }
  // Открыть страницу, сам проходя переадресации и сохраняя куки сеанса (как браузер)
  async function page(url, cookie) {
    const trail = [];
    for (let i = 0; i < 6; i++) {
      const g = await raw('GET', url, null, cookie);
      if (g.cookie) cookie = g.cookie;
      trail.push(g.status + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
      if (g.status >= 300 && g.status < 400 && g.location) { url = /^https?:/.test(g.location) ? g.location : base({ url: url.match(/^https?:\/\/[^/]+/)[0] }) + (g.location[0] === '/' ? '' : '/') + g.location; continue; }
      return { text: g.text || '', cookie, url: g.finalUrl || url, status: g.status, trail };
    }
    return { text: '', cookie, url, status: 310, trail };
  }
  const plain = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  // Вход так же, как в браузере: открыть страницу входа, взять защитный код формы, отправить логин и пароль.
  // Нужен, когда у Aurora свой порядок входа и обычный вход для программ она отклоняет.
  async function formLogin(cfg) {
    // Сначала без названия базы — как человек, открывший сайт: сервер сам выберет базу. Не вышло — с названием из настроек.
    const csrfOf = (t) => (t.match(/name="csrf_token"[^>]*value="([^"]+)"/) || t.match(/value="([^"]+)"[^>]*name="csrf_token"/) || t.match(/csrf_token:\s*"([^"]+)"/) || [])[1];
    let g = await page(base(cfg) + '/web/login'), trail = g.trail.slice();
    if (!csrfOf(g.text) && cfg.db) { const g2 = await page(base(cfg) + '/web/login?db=' + encodeURIComponent(cfg.db), g.cookie); trail = trail.concat(g2.trail); if (csrfOf(g2.text)) g = g2; }
    const html = g.text || '', csrf = csrfOf(html);
    if (!csrf) {
      // Страница выбора базы: покажем, какие базы предлагает сервер
      const dbs = (html.match(/[?&]db=([^"'&\s]+)/g) || []).map((x) => decodeURIComponent(x.replace(/^.*db=/, ''))).filter((x, i, a) => a.indexOf(x) === i);
      throw new AuroraError('страница входа не открылась (путь: ' + trail.join(' → ') + ')' + (dbs.length ? ' · сервер предлагает базы: ' + dbs.join(', ') : '') + ' · заголовок страницы: «' + plain((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1]) + '»', 'url');
    }
    const u = g.url.indexOf('/web/login') >= 0 ? g.url : base(cfg) + '/web/login';
    const names = (html.match(/<input[^>]*name="[^"]+"/g) || []).map((x) => (x.match(/name="([^"]+)"/) || [])[1]).filter((x, i, a) => a.indexOf(x) === i);
    const extra = names.filter((n) => !/^(csrf_token|login|password|redirect|db)$/.test(n));
    let cookie = g.cookie;
    const pr = await raw('POST', u, { csrf_token: csrf, login: cfg.login, password: cfg.password, redirect: '' }, cookie);
    trail.push(pr.status + ' POST');
    if (pr.cookie) cookie = pr.cookie;
    const fields = 'поля формы: ' + names.join(', ');
    if (pr.status >= 300 && pr.status < 400 || pr.status === 0) {
      const r = await rpc(cfg, '/web/session/get_session_info', {}, cookie);
      const si = r.result || {};
      if (si.uid) return { cookie, uid: si.uid, name: si.name || si.username || cfg.login, version: si.server_version || '', db: si.db || cfg.db || '' };
      throw new AuroraError('Форма входа приняла данные, но сеанс не открылся (' + fields + ')', 'auth');
    }
    const alert = (pr.text.match(/<p[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/p>/) || pr.text.match(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    throw new AuroraError('страница входа ответила: «' + (plain(alert) || 'без объяснения, код ' + pr.status) + '» (путь: ' + trail.join(' → ') + ')' + (extra.length ? ' · на форме есть дополнительные поля: ' + extra.join(', ') : '') + ' (' + fields + ')', 'auth');
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
      // Обычный вход отклонён — пробуем войти так же, как браузер (через страницу входа)
      let formErr = '';
      try { const f = await formLogin(cfg); sess = Object.assign({ key: keyOf(cfg), via: 'form' }, f); return sess; }
      catch (e2) { if (e2.kind === 'net') throw e2; formErr = e2.message; }
      e.message += '. Вход как в браузере тоже не прошёл: ' + formErr;
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

  /* ---- Поиск пациента и его заказа на выезд по ID пациента.
     Как устроено в этой Aurora (по отчёту структуры):
       his.patient         — пациент; «ID пациента» на листе заказа = номер его карточки контакта (partner_id);
       his.patient_visit   — визит (is_home_visit — вызов на дом: адрес, время, заказы);
       his.order_detail    — строки заказа: услуга (product.product), цена, итог;
       sale.order          — счёт; его номер — «ID счёта» на листе. ---- */
  const dmy = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '.' + m[2] + '.' + m[1] : ''; };
  const m2o = (v) => (Array.isArray(v) ? { id: v[0], name: String(v[1] || '') } : { id: 0, name: '' });
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const PAT_F = ['first_name', 'last_name', 'middle_name', 'full_name', 'phone_number', 'phone_number_2', 'gender', 'date', 'partner_id', 'home_visit_address', 'home_visit_comment', 'intercom_code', 'full_address'];
  const VIS_F = ['date', 'visit_status', 'is_home_visit', 'home_visit_address', 'home_visit_period_id', 'phone_number', 'total_amount', 'sale_order_ids', 'comment', 'patient_comment', 'main_visit_id', 'scheduled_time'];
  const DET_F = ['service_id', 'price', 'total', 'quantity', 'status', 'pack_parent_line_id', 'pack_type', 'is_free', 'patient_visit_id', 'main_visit_id', 'list_of_bio_materials'];

  async function findPatient(cfg, id) {
    const n = +String(id || '').replace(/\D/g, '');
    if (!n) throw new AuroraError('Введите ID пациента — только цифры', 'cfg');
    let r = await call(cfg, 'his.patient', 'search_read', [[['partner_id', '=', n]]], { fields: PAT_F, limit: 1 });
    if (!r.length) r = await call(cfg, 'his.patient', 'search_read', [[['id', '=', n]]], { fields: PAT_F, limit: 1 });
    if (!r.length) throw new AuroraError('Пациент с ID ' + n + ' в Aurora не найден', 'notfound');
    const p = r[0], g = String(p.gender || '').toLowerCase();
    return {
      rid: p.id, pid: String(m2o(p.partner_id).id || n),
      last: p.last_name || '', first: p.first_name || '', middle: p.middle_name || '', full: p.full_name || '',
      dob: dmy(p.date), sex: /^(m|муж|er)/.test(g) ? 'm' : /^(f|жен|ay)/.test(g) ? 'f' : '',
      phone: String(p.phone_number || '').replace(/\D/g, '').slice(-9), phone2: String(p.phone_number_2 || '').replace(/\D/g, '').slice(-9),
      address: p.home_visit_address || p.full_address || '', comment: [p.home_visit_comment, p.intercom_code ? 'домофон ' + p.intercom_code : ''].filter(Boolean).join(' · '),
    };
  }
  // Визиты пациента: сначала вызовы на дом (сегодня и будущие — первыми), если их нет — последние обычные визиты
  async function visits(cfg, patient) {
    const base = [['patient_id', '=', patient.rid]];
    let v = await call(cfg, 'his.patient_visit', 'search_read', [base.concat([['is_home_visit', '=', true]])], { fields: VIS_F, limit: 30, order: 'date desc, id desc' });
    if (!v.length) v = await call(cfg, 'his.patient_visit', 'search_read', [base], { fields: VIS_F, limit: 6, order: 'date desc, id desc' });
    const t = today();
    const up = v.filter((x) => x.date && x.date >= t).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.id - a.id));
    const past = v.filter((x) => !x.date || x.date < t);
    // Под-визиты (отдельные услуги одного приезда) сводим к главному визиту
    const seen = {}, uniq = up.concat(past).filter((x) => { const root = m2o(x.main_visit_id).id || x.id; x._root = root; if (seen[root]) return false; seen[root] = 1; return true; });
    return uniq.map((x) => ({ id: x._root, date: x.date || '', dateText: dmy(x.date), home: !!x.is_home_visit, status: x.visit_status || '', period: m2o(x.home_visit_period_id).name, address: x.home_visit_address || '', phone: String(x.phone_number || '').replace(/\D/g, '').slice(-9), total: x.total_amount || 0, orders: x.sale_order_ids || [], comment: [x.comment, x.patient_comment].filter(Boolean).join(' · ') }));
  }
  // Строки заказа одного визита (вместе с под-визитами). Отменённые и составные части комплексов не берём.
  async function lines(cfg, visitId) {
    const d = await call(cfg, 'his.order_detail', 'search_read', [['|', ['patient_visit_id', '=', visitId], ['main_visit_id', '=', visitId]]], { fields: DET_F, limit: 200, order: 'id' });
    const out = [], skipped = [];
    d.forEach((x) => {
      const svc = m2o(x.service_id), row = { id: x.id, productId: svc.id, name: svc.name.replace(/^\[[^\]]*\]\s*/, ''), price: Math.round(x.price || 0), total: Math.round(x.total || 0), qty: x.quantity || 1, status: String(x.status || ''), pack: x.pack_type || '', child: !!x.pack_parent_line_id, bio: x.list_of_bio_materials || '' };
      if (/cancel|отмен|reject|refus/i.test(row.status)) { row.why = 'отменена'; skipped.push(row); }
      else if (row.child) { row.why = 'часть комплекса'; skipped.push(row); }
      else if (!svc.id) { row.why = 'без услуги'; skipped.push(row); }
      else out.push(row);
    });
    return { lines: out, skipped };
  }
  async function order(cfg, id, visitId) {
    const patient = await findPatient(cfg, id);
    const vs = await visits(cfg, patient);
    const visit = (visitId && vs.find((x) => x.id === visitId)) || vs[0] || null;
    const l = visit ? await lines(cfg, visit.id) : { lines: [], skipped: [] };
    if (visit) visit.orders = await saleOrders(cfg, visit.id, visit.orders);
    return { patient, visits: vs, visit, lines: l.lines, skipped: l.skipped };
  }

  // Счёт (sale.order) визита: его номер — «ID счёта» на листе заказа. Ищем по визиту и его под-визитам.
  async function saleOrders(cfg, visitId, known) {
    if (known && known.length) return known;
    try {
      const vs = await call(cfg, 'his.patient_visit', 'search', [['|', ['id', '=', visitId], ['main_visit_id', '=', visitId]]], { limit: 100 });
      const so = await call(cfg, 'sale.order', 'search_read', [[['patient_visit_id', 'in', vs.length ? vs : [visitId]], ['state', '!=', 'cancel']]], { fields: ['name', 'state', 'amount_total'], limit: 20, order: 'id desc' });
      return so.map((x) => x.id);
    } catch (e) { return []; }
  }
  /* Справочник из Aurora: услуги с ценами и какие контейнеры (пробирки) нужны каждой услуге.
     lis.container — виды контейнеров; lis.biomaterial_container_map — услуга → биоматериал → контейнер. */
  async function catalog(cfg, say) {
    say = say || (() => {});
    say('Контейнеры…');
    const cs = await call(cfg, 'lis.container', 'search_read', [[]], { fields: ['name', 'code', 'short_name', 'color', 'container_id'], limit: 1000 });
    say('Пробирки для анализов…');
    const mp = await call(cfg, 'lis.biomaterial_container_map', 'search_read', [[]], { fields: ['product_id', 'bio_material_id', 'container_id'], limit: 20000 });
    say('Цены…');
    const pr = await call(cfg, 'product.product', 'search_read', [[['sale_ok', '=', true]]], { fields: ['name', 'lst_price'], limit: 20000 });
    const num = (c) => { for (const v of [c.code, c.container_id, c.short_name]) { const m = String(v || '').trim().match(/^0*(\d{1,3})$/); if (m) return +m[1]; } return 0; };
    const cont = {}; cs.forEach((c) => { cont[c.id] = { no: num(c), name: c.name || '', short: c.short_name || '', color: /^#[0-9a-f]{6}$/i.test(String(c.color || '')) ? c.color : '', code: String(c.code || '') }; });
    const tubes = {}; mp.forEach((m) => { const pid = m2o(m.product_id).id, cid = m2o(m.container_id).id; if (!pid || !cid) return; const a = (tubes[pid] = tubes[pid] || []); if (!a.some((x) => x[0] === cid)) a.push([cid, m2o(m.bio_material_id).name]); });
    const prod = {}; pr.forEach((x) => { prod[x.id] = [String(x.name || ''), Math.round(x.lst_price || 0)]; });
    return { ts: Date.now(), cont, tubes, prod };
  }

  const api = { login, call, logout, discover, order, findPatient, catalog, AuroraError, _shape: shape, _dmy: dmy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Aurora = api;
})(typeof window !== 'undefined' ? window : globalThis);
