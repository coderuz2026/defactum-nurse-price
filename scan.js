/* Сканирование листа заказа Aurora: фото → текст (на телефоне, без отправки в интернет) → пациент и анализы.
   Чистые функции разбора (parseSheet, matchSheet) проверяются в tools/calc_test.js. */
'use strict';
const Scan = (() => {
  /* ---------- Нормализация: OCR путает кириллицу, латиницу и цифры ---------- */
  const FOLD = { 'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': '0', 'o': '0', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'з': '3', 'l': '1', 'i': '1', '|': '1', 'й': 'и', 'д': 'd', 'б': '6' };
  const norm = (s) => String(s || '').toLowerCase().replace(/./g, (c) => FOLD[c] !== undefined ? FOLD[c] : c).replace(/[^a-zа-я0-9]/g, '');
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  function dice(a, b) {
    if (a.length < 2 || b.length < 2) return 0;
    const A = grams(a), B = grams(b); let common = 0;
    A.forEach((n, g) => { if (B.has(g)) common += Math.min(n, B.get(g)); });
    return 2 * common / (a.length - 1 + b.length - 1);
  }

  /* ---------- Числа ---------- */
  const DIG = { 'O': '0', 'o': '0', 'О': '0', 'о': '0', '©': '0', 'B': '8', 'В': '8', 'в': '8', 'C': '0', 'С': '0', 'с': '0', 'З': '3', 'з': '3', 'l': '1', 'I': '1', '|': '1' };
  const fixDigits = (t) => t.replace(/[OoОо©BВвCСсЗзlI|]/g, (c) => DIG[c]);
  const PRICE_TOKEN = /^[\dOoОо©BВвCСсЗз]{3,}[.,][\dOoОо]{1,2}$/;
  const isNumTok = (t) => PRICE_TOKEN.test(t) || /^\d{5,}$/.test(t);
  const okPrice = (n) => Number.isFinite(n) && n >= 5000 && n <= 20000000 && n % 1000 === 0;
  function tokPrice(t) { // «80090.90» → 80 000: одиночная ошибка в цифре сотен/десятков прощается, цены в прайсе кратны 1000
    const n = Math.floor(parseFloat(fixDigits(t).replace(',', '.'))); if (!Number.isFinite(n)) return null;
    const r = Math.round(n / 1000) * 1000; return okPrice(r) && Math.abs(n - r) <= 100 ? r : null;
  }
  function moneyAfterColon(line) { // «Итого: 1 060 000»; «630 C00 |» и «630 ©20» тоже читаются как 630 000
    const m = line.split(':').slice(1).join(':'); if (!m) return null;
    const g = fixDigits(m).match(/\d{1,3}(?:[ \u00a0]?\d{3})+/); // первое число с разрядами; хвост от линии таблицы отбрасываем
    if (!g) return null;
    const n = parseInt(g[0].replace(/\D/g, ''), 10), r = Math.round(n / 1000) * 1000;
    return okPrice(r) && Math.abs(n - r) <= 100 ? r : null; // как у цен: одна ошибка в сотнях/десятках прощается
  }

  const mode = (a) => a.slice().sort((x, y) => a.filter((v) => v === y).length - a.filter((v) => v === x).length)[0]; // чаще встречающееся значение

  /* ---------- Разбор текста листа ---------- */
  const afterColon = (l) => l.slice(l.search(/[:;]/) + 1).trim();
  const cyrWords = (s) => (s.match(/[А-ЯЁа-яёЎўҚқҒғҲҳ'ʼ`-]{2,}/g) || []);
  const PATRONYMIC = /[а-яё]{3,}(овна|евна|ична|ович|евич)(?![а-яё])|(^|\s)(кизи|қизи|кызы|угли|ўғли|оглы|qizi|o'g'li)(?![а-яёa-z])/i;
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
  function fioFrom(line) {
    const left = String(line || '').split(/[1I|Il]?[DО]?\s*пациента/i)[0];
    const body = /[:;]/.test(left.slice(0, 8)) ? afterColon(left) : left;
    let w = cyrWords(body).filter((x) => !/^(пациента|пол|женщина|мужчина)$/i.test(x));
    if (w.length > 2 && /^(фи|ф[иi1]о|duno)/i.test(w[0]) && w[0].length <= 4) w = w.slice(1); // метка «ФИО», прочитанная как слово
    w = w.filter((x, k) => k < 2 || x.length >= 4).slice(0, 3);                              // обрывки справа от ФИО
    w = w.map((x) => /^([бвгджзклмнпрстфхцчшщ])\1/i.test(x) ? x.slice(1) : x);               // удвоенная первая буква: «Нназарова» → «Назарова»
    return { last: w[0] ? cap(w[0]) : '', first: w[1] ? cap(w[1]) : '', middle: w[2] ? cap(w[2]) : '' };
  }
  function parseSheet(text, idText) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const L = lines.map((l) => l.toLowerCase());
    const r = { last: '', first: '', middle: '', sex: '', dob: '', phone: '', pid: '', order: '', orderDate: '', callTime: '', address: '', comment: '', rows: [], totals: [] };
    const find = (re) => L.findIndex((l) => re.test(l));
    // ФИО и ID пациента обычно в одной строке, но при чтении колонки могут разойтись по разным строкам
    let i = find(/пациента\s*[:;]?\s*\d{4,}/);
    if (i >= 0) { const idm = lines[i].match(/пациента\s*[:;]?\s*(\d{4,8})/i); if (idm) r.pid = idm[1]; }
    const cand = [i, find(/^\W{0,3}(фи[о0]|ф\.и\.о|duno)(?![а-яёa-z])/), L.findIndex((l, k) => k < 12 && PATRONYMIC.test(l))].filter((k) => k >= 0);
    for (const k of cand) { const f = fioFrom(lines[k]); if (f.last && f.first) { [r.last, r.first, r.middle] = [f.last, f.first, f.middle]; break; } }
    i = find(/^пол\b|^.{0,3}пол\s*[:;]/); if (i >= 0) r.sex = /жен/.test(L[i]) ? 'f' : /муж/.test(L[i]) ? 'm' : '';
    const dateIn = (s) => { const m = fixDigits(s).match(/(\d{2})[.,\s]?(\d{2})[.,\s]?((?:19|20)\d{2})/); return m ? `${m[1]}.${m[2]}.${m[3]}` : ''; };
    i = find(/рождени/); if (i >= 0) { r.dob = dateIn(lines[i].split(/время/i)[0].replace(/^.*?рождени\S*/i, '')); const t = lines[i].match(/(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})/); if (t) r.callTime = `${t[1]}-${t[2]}`.replace(/\./g, ':'); }
    i = find(/дата заказа/); if (i >= 0) r.orderDate = dateIn(lines[i].replace(/^.*дата заказа/i, ''));
    i = find(/телефона\s*[:;]/); if (i >= 0) { const m = lines[i].replace(/\s/g, '').match(/\+?998(\d{9})/); if (m) r.phone = m[1]; }
    i = find(/адрес\s+вы[еe]зда/); if (i >= 0) r.address = afterColon(lines[i]).replace(/\s+,/g, ',');
    i = find(/^коммент/); if (i >= 0) { const c = afterColon(lines[i]); if (c && !/^коммент/i.test(c)) r.comment = c; }
    const idm = (String(idText || '') + '\n' + text).match(/сч[её]та\s*[:;]?\s*(\d{5,8})/i); if (idm) r.order = idm[1];

    // Таблица услуг: от шапки до «Итого»
    let s = find(/наименован|услуги/);
    if (s < 0) s = Math.max(find(/домофона|номер дома/), find(/сч[её]та/)); let e = L.findIndex((l, k) => k > s && /^.{0,6}итого/.test(l));
    if (e < 0) e = L.findIndex((l, k) => k > s && /сумма к оплате\s*[:;]/.test(l));
    if (e < 0) e = lines.length;
    const isPatient = (l) => /[пn][аaеe][цu][иu][еeё]нт\W*$/i.test(l);
    for (let k = s + 1; k < e && s >= 0; k++) {
      const line = lines[k], toks = line.split(' ');
      const firstNum = toks.findIndex((t, j) => j > 0 && isNumTok(t.replace(/[()[\]{}]/g, '')));
      if (firstNum > 0 || isPatient(line)) {
        let cut = firstNum > 0 ? firstNum : toks.length - 1;
        if (cut > 1 && /^[\\KКк1lI]?[.,]?[\dоОoO9]{1,3}$|^\d[.,]\d$/.test(toks[cut - 1]) && toks[cut - 1].length <= 4) cut--; // количество «1.0»
        let name = toks.slice(0, cut).join(' ');
        name = name.replace(/^(?:[^A-Za-zА-Яа-яЁё]{1,3}|[A-Za-zА-Яа-яЁё\d]{1,2}[.)]?)\s+(?=\S{3,})/, '').replace(/^\d{1,2}[оo]?(?=[А-ЯЁ])/, '').trim();
        const prices = toks.slice(cut).map((t) => tokPrice(t.replace(/[()[\]{}]/g, ''))).filter((x) => x);
        r.rows.push({ name, more: '', price: prices.length ? mode(prices) : null, raw: line });
      } else if (r.rows.length && /[A-Za-zА-Яа-яЁё]{4,}/.test(line)) {
        const row = r.rows[r.rows.length - 1]; row.more = (row.more + ' ' + line).trim();
      }
    }
    lines.forEach((l) => { if (/^.{0,6}итого|сумма к оплате/i.test(l)) { const n = moneyAfterColon(l); if (n) r.totals.push(n); } });
    return r;
  }

  /* ---------- Сопоставление строк листа с прайсом ---------- */
  function matchSheet(sheet, items) {
    const idx = matchSheet._idx && matchSheet._src === items ? matchSheet._idx : (matchSheet._src = items, matchSheet._idx = items.map((it) => ({ it, n: norm(it.name) })));
    const out = { items: [], extra: [], total: null, sum: 0, ok: false };
    const used = new Set();
    sheet.rows.forEach((row) => {
      const a = norm(row.name), b = norm(row.name + ' ' + row.more);
      let best = null, second = 0;
      idx.forEach(({ it, n }) => {
        let sc = Math.max(dice(a, n), dice(b, n), a.length >= 8 && n.startsWith(a.slice(0, Math.min(a.length, n.length))) ? 0.9 : 0);
        if (row.price && row.price === it.price) sc += 0.06; // цена на листе совпала с прайсом
        if (!best || sc > best.sc) { second = best ? best.sc : 0; best = { it, sc }; } else if (sc > second) second = sc;
      });
      if (best && best.sc >= 0.5 && !used.has(best.it.id)) {
        used.add(best.it.id);
        out.items.push({ id: best.it.id, name: best.it.name, price: best.it.price, sheetPrice: row.price, score: Math.min(1, best.sc), sure: best.sc >= 0.68 && best.sc - second >= 0.04, raw: row.raw });
      } else {
        const visit = /вызов\s*(на|ha)\s*дом|выезд/i.test(row.name) || dice(norm(row.name), norm('Вызов на дом')) >= 0.45 || /дом\b/i.test(row.name) && norm(row.name).length <= 16; // «бозовнадом» — тоже он
        const clean = visit ? 'Вызов на дом' : (row.name + (row.more ? ' ' + row.more : '')).replace(/\s+/g, ' ').trim();
        if (clean.length >= 3) out.extra.push({ name: clean, price: row.price || 0, sure: !!row.price && visit, raw: row.raw });
      }
    });
    const sumItems = out.items.reduce((s, x) => s + x.price, 0);
    const sumAll = () => sumItems + out.extra.reduce((s, x) => s + x.price, 0);
    // Итог листа: значение, которое подтверждается суммой строк; иначе — первое прочитанное (тогда будет предупреждение).
    // Цены строк по итогу НЕ подгоняем: иначе пропущенная строка осталась бы незамеченной.
    const totals = sheet.totals || [];
    // Лишние обрывки (кусок колонки «Сумма к оплате» на отдельной строке и т. п.): если без каких-то нераспознанных строк
    // сумма ровно совпадает с «Итого» — эти строки в итог не входят, это мусор распознавания. Распознанные анализы и вызов на дом не трогаем.
    if (totals.length && !totals.includes(sumAll())) {
      const junk = out.extra.map((x, i) => ({ x, i })).filter(({ x }) => x.price && x.name !== 'Вызов на дом');
      if (junk.length && junk.length <= 8) {
        let drop = null;
        for (let mask = 1; mask < (1 << junk.length) && !drop; mask++) {
          const part = junk.filter((_, k) => mask & (1 << k)), cut = part.reduce((s, { x }) => s + x.price, 0);
          if (totals.includes(sumAll() - cut)) drop = part;
        }
        if (drop) { const del = new Set(drop.map(({ i }) => i)); out.dropped = drop.map(({ x }) => x); out.extra = out.extra.filter((_, i) => !del.has(i)); }
      }
    }
    out.total = totals.find((t) => t === sumAll()) || totals[0] || null;
    out.sum = sumAll();
    out.ok = !!out.total && out.total === out.sum && out.items.length > 0;
    return out;
  }

  /* ---------- Распознавание в браузере (Tesseract, файлы лежат в vendor/tesseract) ---------- */
  const base = () => new URL('vendor/tesseract/', document.baseURI).href;
  const inApk = () => !!window.Capacitor || (location.protocol === 'https:' && location.hostname === 'localhost');
  const CFG = { budget: 14000, paperW: 1700, split: true, crop: true, warp: true, lines: true, norm: true, gamma: 1.3, zooms: [1.6, 1.3, 2], params: { tessedit_pageseg_mode: '6', tessedit_do_invert: '0', user_defined_dpi: '200' } }; // режим страницы задаём всегда: параметры в модуле сохраняются между вызовами
  const ID_RE = /сч[её]та\s*[:;]?\s*\d{5,8}/i;
  // Два потока распознавания: верх листа (данные пациента) и низ (таблица услуг) читаются одновременно
  const pool = [null, null], poolKey = ['', ''];
  let progressCb = null;
  const canPair = () => (navigator.hardwareConcurrency || 2) >= 4 && !(navigator.deviceMemory && navigator.deviceMemory < 2); // браузер округляет память вниз: 3 ГБ показывает как 2
  function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Не загрузился модуль распознавания')); document.head.appendChild(s); }); }
  let libP = null;
  const lib = () => libP || (libP = (window.Tesseract ? Promise.resolve() : loadScript(base() + 'tesseract.min.js')).catch((e) => { libP = null; throw e; }));
  function getWorker(i) {
    i = i || 0;
    if (!pool[i]) pool[i] = lib().then(() => window.Tesseract.createWorker(['rus', 'eng'], 1, {
      workerPath: base() + 'worker.min.js', corePath: base(), langPath: base() + 'lang', gzip: !inApk(), // Android при сборке APK сам распаковывает .gz
      logger: (m) => { if (i === 0 && progressCb && m.status) progressCb(m.status === 'recognizing text' ? 0.3 + 0.6 * m.progress : 0.05 + 0.25 * (m.progress || 0), m.status); }
    })).catch((e) => { pool[i] = null; throw e; });
    return pool[i];
  }
  async function ocr(canvas, params, i) {
    i = i || 0;
    const w = await getWorker(i), key = JSON.stringify(params || {});
    if (key !== poolKey[i]) { await w.setParameters(params || {}); poolKey[i] = key; }
    return (await w.recognize(canvas)).data;
  }
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  async function loadBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('Не удалось открыть фото')); im.src = URL.createObjectURL(file); }); }
  }
  // Где на фото лист бумаги: светлый прямоугольник на более тёмном фоне (стол).
  // lum — яркость пикселей уменьшенного кадра W×H. Возвращает рамку листа в долях кадра (без запаса) или null.
  function paperIn(lum, W, H) {
    const hist = new Uint32Array(256); for (let j = 0; j < lum.length; j++) hist[lum[j]]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128; // порог Оцу
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = lum.length - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = t; } }
    const rows = new Float32Array(H), cols = new Float32Array(W);
    let bright = 0, bsum = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = lum[y * W + x]; if (v > thr) { rows[y]++; cols[x]++; bright++; bsum += v; } }
    const span = (a, n, need) => { let lo = 0, hi = a.length - 1; while (lo < hi && a[lo] / n < need) lo++; while (hi > lo && a[hi] / n < need) hi--; return [lo, hi]; };
    const [y0, y1] = span(rows, W, 0.4), [x0, x1] = span(cols, H, 0.4);
    if ((x1 - x0) < W * 0.45 || (y1 - y0) < H * 0.4) return null;
    return { x: x0 / W, y: y0 / H, w: (x1 + 1 - x0) / W, h: (y1 + 1 - y0) / H, thr, light: bright ? bsum / bright : 0 };
  }
  // Четыре угла листа. Берём самую крупную связную светлую область, по ней — точки левого, правого, верхнего и нижнего края
  // и проводим через каждый край прямую так, чтобы случайные выступы (блик, светлый край стола) не сбивали её.
  // Углы — пересечения прямых: [ЛВ, ПВ, ПН, ЛН] в долях кадра. null — лист не похож на четырёхугольник (тогда работаем по рамке, как раньше).
  function paperQuad(lum, W, H, core) {
    const thr = core.thr, n = W * H, comp = new Uint8Array(n), stack = new Int32Array(n);
    // затравка — середина «ядра» листа, найденного по строкам и столбцам
    let seed = -1;
    const cx = Math.round((core.x + core.w / 2) * W), cy = Math.round((core.y + core.h / 2) * H);
    for (let r = 0; r < Math.min(W, H) / 4 && seed < 0; r++) for (let dy = -r; dy <= r && seed < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < W && y < H && lum[y * W + x] > thr) { seed = y * W + x; break; }
    }
    if (seed < 0) return null;
    let sp = 0, cnt = 0; stack[sp++] = seed; comp[seed] = 1;
    while (sp) {
      const i = stack[--sp], x = i % W; cnt++;
      if (x > 0 && !comp[i - 1] && lum[i - 1] > thr) { comp[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < W - 1 && !comp[i + 1] && lum[i + 1] > thr) { comp[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= W && !comp[i - W] && lum[i - W] > thr) { comp[i - W] = 1; stack[sp++] = i - W; }
      if (i < n - W && !comp[i + W] && lum[i + W] > thr) { comp[i + W] = 1; stack[sp++] = i + W; }
    }
    if (cnt < n * 0.15) return null;
    // точки краёв по средней части листа (без углов)
    const x0 = Math.round(core.x * W), x1 = Math.round((core.x + core.w) * W), y0 = Math.round(core.y * H), y1 = Math.round((core.y + core.h) * H);
    const L = [], R = [], T = [], B = [];
    for (let y = Math.round(y0 + (y1 - y0) * 0.12); y <= y1 - (y1 - y0) * 0.12; y++) {
      let a = 0; while (a < W && !comp[y * W + a]) a++;
      let b = W - 1; while (b >= 0 && !comp[y * W + b]) b--;
      if (a <= b) { L.push([y, a]); R.push([y, b + 1]); }
    }
    for (let x = Math.round(x0 + (x1 - x0) * 0.12); x <= x1 - (x1 - x0) * 0.12; x++) {
      let a = 0; while (a < H && !comp[a * W + x]) a++;
      let b = H - 1; while (b >= 0 && !comp[b * W + x]) b--;
      if (a <= b) { T.push([x, a]); B.push([x, b + 1]); }
    }
    // прямая s = k·t + c, устойчиво (RANSAC): перебираем прямые через пары точек края, берём ту, рядом с которой больше всего точек,
    // и уточняем по этим точкам методом наименьших квадратов. Тень, блик или светлый край стола остаются в стороне.
    const fit = (pts) => {
      const m = pts.length; if (m < 10) return null;
      const near = (k, c, tol) => pts.filter(([t, v]) => Math.abs(v - (k * t + c)) <= tol);
      let bestK = 0, bestC = 0, bestN = -1;
      for (let i = 0; i < 80; i++) {
        const p = pts[(i * 7919) % m], q = pts[(i * 104729 + (m >> 1)) % m];
        if (Math.abs(q[0] - p[0]) < m * 0.2) continue; // точки слишком близко — прямая неточная
        const k = (q[1] - p[1]) / (q[0] - p[0]), c = p[1] - k * p[0], nIn = near(k, c, 1.2).length;
        if (nIn > bestN) { bestN = nIn; bestK = k; bestC = c; }
      }
      if (bestN < m * 0.4) return null;
      const use = near(bestK, bestC, 1.5);
      let st = 0, ss = 0, stt = 0, sts = 0; const u = use.length;
      for (const [t, v] of use) { st += t; ss += v; stt += t * t; sts += t * v; }
      const den = u * stt - st * st; if (!den) return null;
      const k = (u * sts - st * ss) / den;
      return { k, c: (ss - k * st) / u, share: u / m };
    };
    const fl = fit(L), fr = fit(R), ft = fit(T), fb = fit(B);
    if (!fl || !fr || !ft || !fb) return null;
    // пересечение «x = kx·y + cx» и «y = ky·x + cy»
    const cross = (v, h) => { const den = 1 - v.k * h.k; if (Math.abs(den) < 1e-6) return null; const x = (v.k * h.c + v.c) / den; return { x: x / W, y: (h.k * x + h.c) / H }; };
    const pt = [cross(fl, ft), cross(fr, ft), cross(fr, fb), cross(fl, fb)];
    if (pt.some((p) => !p || p.x < -0.03 || p.y < -0.03 || p.x > 1.03 || p.y > 1.03)) return null;
    let area = 0;
    for (let k = 0; k < 4; k++) { const a = pt[k], b = pt[(k + 1) % 4]; area += a.x * b.y - b.x * a.y; }
    if (Math.abs(area) / 2 < 0.15) return null;
    for (let k = 0; k < 4; k++) {
      const p0 = pt[(k + 3) % 4], p1 = pt[k], p2 = pt[(k + 1) % 4];
      const v1 = { x: (p0.x - p1.x) * W, y: (p0.y - p1.y) * H }, v2 = { x: (p2.x - p1.x) * W, y: (p2.y - p1.y) * H };
      const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
      if (Math.abs(cos) > 0.45) return null; // угол вне 63°…117° — это не лист
    }
    return pt.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }));
  }
  const lumOf = (d, n) => { const lum = new Uint8Array(n); for (let i = 0, j = 0; j < n; i += 4, j++) lum[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; return lum; };
  function findPaper(bmp) {
    const k = 200 / Math.max(bmp.width, bmp.height), c = mk(bmp.width * k, bmp.height * k), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const W = c.width, H = c.height, b = paperIn(lumOf(g.getImageData(0, 0, W, H).data, W * H), W, H);
    if (!b) return { x: 0, y: 0, w: 1, h: 1 }; // лист не выделился — берём кадр целиком
    const m = 0.012; // небольшой запас по краям
    const fx = Math.max(0, b.x - m), fy = Math.max(0, b.y - m);
    return { x: fx, y: fy, w: Math.min(1, b.x + b.w + m) - fx, h: Math.min(1, b.y + b.h + m) - fy };
  }

  /* ---------- Кадр камеры: виден ли лист целиком, достаточно ли он крупный и резкий ---------- */
  // img — {data, width, height} уменьшенного кадра (длинная сторона ~240 точек)
  function frameInfo(img) {
    const W = img.width, H = img.height, lum = lumOf(img.data, W * H), b = paperIn(lum, W, H);
    if (!b) return { found: false };
    const edge = 0.015; // лист не должен касаться краёв кадра — иначе часть листа не видна
    const quad = paperQuad(lum, W, H, b);
    if (quad) {
      // углы листа нашлись — проверяем по ним: яркое окно или рука рядом с листом не мешают
      const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y), box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const e2 = 0.004; // углы известны точно — достаточно, чтобы все четыре были в кадре
      const whole = quad.every((p) => p.x > e2 && p.y > e2 && p.x < 1 - e2 && p.y < 1 - e2);
      const side = W <= H ? (Math.hypot((quad[1].x - quad[0].x) * W, (quad[1].y - quad[0].y) * H) + Math.hypot((quad[2].x - quad[3].x) * W, (quad[2].y - quad[3].y) * H)) / 2 / W
        : (Math.hypot((quad[3].x - quad[0].x) * W, (quad[3].y - quad[0].y) * H) + Math.hypot((quad[2].x - quad[1].x) * W, (quad[2].y - quad[1].y) * H)) / 2 / H;
      return { found: true, box, quad, whole, big: side >= 0.5, light: Math.round(b.light) };
    }
    const whole = b.x > edge && b.y > edge && b.x + b.w < 1 - edge && b.y + b.h < 1 - edge;
    // лист должен занимать заметную часть кадра: по короткой стороне кадра — не меньше половины
    const big = (W <= H ? b.w : b.h) >= 0.5;
    return { found: true, box: { x: b.x, y: b.y, w: b.w, h: b.h }, quad: null, whole, big, light: Math.round(b.light) };
  }
  // Резкость: дисперсия лапласиана по яркости (у размытого текста перепады яркости мягкие — значение маленькое)
  function sharpness(img) {
    const W = img.width, H = img.height, lum = lumOf(img.data, W * H);
    let n = 0, s = 0, s2 = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, v = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W];
      n++; s += v; s2 += v * v;
    }
    if (!n) return 0;
    const m = s / n; return s2 / n - m * m;
  }
  // Рамки соседних кадров почти совпадают — телефон держат неподвижно
  const sameBox = (a, b, tol) => !!a && !!b && Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.w - b.w) < tol && Math.abs(a.h - b.h) < tol;

  // Углы листа на фото (анализ на уменьшенной копии, длинная сторона 400 точек)
  function findQuad(bmp) {
    const k = 400 / Math.max(bmp.width, bmp.height), c = mk(bmp.width * k, bmp.height * k), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const W = c.width, H = c.height, lum = lumOf(g.getImageData(0, 0, W, H).data, W * H), b = paperIn(lum, W, H);
    return b ? paperQuad(lum, W, H, b) : null;
  }
  // Перспективное преобразование: для точки результата (u, v) — где она на исходном фото. 8 уравнений по 4 парам точек.
  function homography(from, to) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const { x: u, y: v } = from[i], { x, y } = to[i];
      A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]); B.push(x);
      A.push([0, 0, 0, u, v, 1, -y * u, -y * v]); B.push(y);
    }
    for (let c = 0; c < 8; c++) { // метод Гаусса с выбором главного элемента
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
      for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; }
    }
    return B.map((b, i) => b / A[i][i]);
  }
  // Выпрямленный лист: ширина как у обычной обрезки (paperW), по краям запас 1,5 %
  function warpPaper(bmp, quad, paperW) {
    const BW = bmp.width, BH = bmp.height, cx = quad.reduce((a, p) => a + p.x, 0) / 4, cy = quad.reduce((a, p) => a + p.y, 0) / 4, m = 1.03;
    const P = quad.map((p) => ({ x: Math.min(1, Math.max(0, cx + (p.x - cx) * m)) * BW, y: Math.min(1, Math.max(0, cy + (p.y - cy) * m)) * BH }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const srcW = Math.max(dist(P[0], P[1]), dist(P[3], P[2])), srcH = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
    const k = Math.min(3.2, paperW / srcW), OW = Math.round(srcW * k), OH = Math.round(srcH * k);
    // исходник: только область вокруг листа, сразу в нужном масштабе (качественное сглаживание браузера), дальше — поворот почти 1:1
    const x0 = Math.max(0, Math.floor(Math.min(...P.map((p) => p.x)))), y0 = Math.max(0, Math.floor(Math.min(...P.map((p) => p.y))));
    const x1 = Math.min(BW, Math.ceil(Math.max(...P.map((p) => p.x)))), y1 = Math.min(BH, Math.ceil(Math.max(...P.map((p) => p.y))));
    const ks = k, sc = mk((x1 - x0) * ks, (y1 - y0) * ks), sg = sc.getContext('2d', { willReadFrequently: true });
    sg.imageSmoothingQuality = 'high'; sg.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, sc.width, sc.height);
    const SW = sc.width, SH = sc.height, src = lumOf(sg.getImageData(0, 0, SW, SH).data, SW * SH);
    const to = P.map((p) => ({ x: (p.x - x0) * ks, y: (p.y - y0) * ks }));
    const h = homography([{ x: 0, y: 0 }, { x: OW, y: 0 }, { x: OW, y: OH }, { x: 0, y: OH }], to);
    const out = mk(OW, OH), og = out.getContext('2d', { willReadFrequently: true }), img = og.createImageData(OW, OH), d = img.data;
    for (let v = 0; v < OH; v++) {
      const vy = v + 0.5;
      let X = h[0] * 0.5 + h[1] * vy + h[2], Y = h[3] * 0.5 + h[4] * vy + h[5], Z = h[6] * 0.5 + h[7] * vy + 1;
      for (let u = 0, o = v * OW * 4; u < OW; u++, o += 4) {
        const sx = X / Z - 0.5, sy = Y / Z - 0.5;
        let val = 255;
        if (sx >= 0 && sy >= 0 && sx < SW - 1 && sy < SH - 1) {
          const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, i = iy * SW + ix;
          const top = src[i] + (src[i + 1] - src[i]) * fx, bot = src[i + SW] + (src[i + SW + 1] - src[i + SW]) * fx;
          val = top + (bot - top) * fy;
        }
        d[o] = d[o + 1] = d[o + 2] = val; d[o + 3] = 255;
        X += h[0]; Y += h[3]; Z += h[6];
      }
    }
    og.putImageData(img, 0, 0);
    return out;
  }
  // Фото → серое изображение листа стандартной ширины, с выровненным светом и без линий таблицы
  async function prepare(file, opt) {
    const bmp = await loadBitmap(file), long = Math.max(bmp.width, bmp.height);
    // лист снят с наклоном или под углом — выпрямляем по четырём углам; не нашли углы — режем по рамке, как раньше
    const quad = opt.crop && opt.warp ? findQuad(bmp) : null;
    let c, box = { x: 0, y: 0, w: 1, h: 1 };
    if (quad) c = warpPaper(bmp, quad, opt.paperW);
    else {
      if (opt.crop) box = findPaper(bmp);
      const sx = box.x * bmp.width, sy = box.y * bmp.height, sw = box.w * bmp.width, sh = box.h * bmp.height, k = Math.min(3.2, opt.paperW / sw);
      c = mk(sw * k, sh * k); const g0 = c.getContext('2d', { willReadFrequently: true });
      g0.imageSmoothingQuality = 'high'; g0.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    }
    const W = c.width, H = c.height, g = c.getContext('2d', { willReadFrequently: true });
    const img = g.getImageData(0, 0, W, H), d = img.data, n = W * H, lum = lumOf(d, n);
    if (opt.norm) {
      // Свет: делим на размытую «карту бумаги» (уменьшили в 40 раз и растянули обратно)
      const s = mk(W / 40, H / 40), sg = s.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(c, 0, 0, s.width, s.height);
      const b = mk(W, H), bg = b.getContext('2d', { willReadFrequently: true }); bg.imageSmoothingQuality = 'high'; bg.drawImage(s, 0, 0, W, H);
      const bd = bg.getImageData(0, 0, W, H).data, lut = new Uint8Array(1025);
      for (let i = 0; i <= 1024; i++) lut[i] = i >= 1024 ? 255 : Math.round(255 * Math.pow(i / 1024, opt.gamma));
      for (let j = 0, i = 0; j < n; j++, i += 4) {
        const bgv = Math.max(40, (bd[i] * 77 + bd[i + 1] * 150 + bd[i + 2] * 29) >> 8) * 0.97;
        lum[j] = lut[Math.min(1024, Math.round(lum[j] / bgv * 1024))];
      }
    }
    if (opt.lines) {
      // Горизонтальные линии таблицы: длинные тёмные отрезки в строке пикселей закрашиваем белым. Буквы короче — не задеваются.
      const minRun = Math.round(W * 0.1), dark = 150;
      for (let y = 0; y < H; y++) {
        const row = y * W; let x = 0;
        while (x < W) {
          if (lum[row + x] >= dark) { x++; continue; }
          let e = x; while (e < W && lum[row + e] < dark) e++;
          if (e - x >= minRun) for (let q = x; q < e; q++) lum[row + q] = 255;
          x = e;
        }
      }
    }
    for (let j = 0, i = 0; j < n; j++, i += 4) { d[i] = d[i + 1] = d[i + 2] = lum[j]; d[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    return { canvas: c, srcLong: long, paper: !!quad || box.w < 1 || box.h < 1, warped: !!quad };
  }
  const crop = (c, x, y, w, h, k) => { const o = mk(w * k, h * k), g = o.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, o.width, o.height); g.drawImage(c, x, y, w, h, 0, 0, o.width, o.height); return o; };
  const lineBoxes = (data) => (data.lines || []).map((l) => ({ text: l.text, y0: l.bbox.y0, y1: l.bbox.y1, words: (l.words || []).map((w) => ({ t: w.text, c: w.confidence })) }));

  // Контрольное чтение блока «ФИО … телефон» (левая колонка листа), крупно
  const isFioLine = (l) => /пациента/i.test(l.text) || /^\W{0,3}(фи[о0]|duno)(?![а-яёa-z])/i.test(l.text.trim()) || PATRONYMIC.test(l.text);
  const wordConf = (ws) => { const f = ws.filter((w) => /^[А-ЯЁа-яё'-]{3,}$/.test(w.t) && !/^(фио|пациента)$/i.test(w.t)).slice(0, 3); return f.length ? Math.round(Math.min.apply(null, f.map((w) => w.c))) : 0; };
  async function headerCheck(canvas, lines, params, worker) {
    const fl = lines.find((l) => l.y0 < canvas.height * 0.4 && isFioLine(l)); if (!fl) return null;
    const t = performance.now(), lh = fl.y1 - fl.y0;
    const last = lines.filter((l) => l.y0 > fl.y0 && l.y0 < fl.y0 + lh * 9 && /телефона\s*[:;]|рождени/i.test(l.text)).pop();
    const y0 = Math.max(0, fl.y0 - Math.round(lh * 0.6)), y1 = Math.min(canvas.height, (last ? last.y1 : fl.y1) + Math.round(lh * 0.6));
    const d = await ocr(crop(canvas, 0, y0, canvas.width * 0.62, y1 - y0, 2), params, worker);
    const sh = parseSheet(d.text, '');
    return { sheet: sh, fio: sh.last ? sh : fioFrom(d.text.split(/\r?\n/).find((l) => cyrWords(l).length >= 2) || ''),
      conf1: wordConf(fl.words), conf2: wordConf((d.words || []).map((w) => ({ t: w.text, c: w.confidence }))), ms: performance.now() - t };
  }

  // Полный цикл: фото → текст → пациент и анализы. Если сумма не сошлась с «Итого», таблица перечитывается крупнее.
  // Одно чтение листа: подготовка фото, текст, разбор, контрольное чтение ФИО. Без повторов таблицы.
  async function readPass(file, items, opt) {
    const t0 = performance.now(), T = {};
    const { canvas, srcLong, paper, warped } = await prepare(file, opt); T.prep = performance.now() - t0; if (opt.debug) window.__prep = canvas;
    let t = performance.now(), data = null, lines = null, headP = null;
    if (opt.split && paper && (opt.pair === 'force' || canPair())) {
      // Бланк стандартный: шапка таблицы примерно на середине листа. Режем с нахлёстом, чтобы ничего не потерять на стыке.
      const H = canvas.height, W = canvas.width, yTop = Math.round(H * 0.56), yBot = Math.round(H * 0.42);
      try {
        const pb = ocr(crop(canvas, 0, yBot, W, H - yBot, 1), opt.params, 1);
        const a = await ocr(crop(canvas, 0, 0, W, yTop, 1), opt.params, 0);
        // верх готов раньше таблицы — пока второй поток дочитывает её, первый сразу делает контрольное чтение ФИО
        headP = headerCheck(canvas, lineBoxes(a), opt.params, 0).catch(() => null);
        const b = await pb;
        const la = a.text.split(/\r?\n/), lb = b.text.split(/\r?\n/);
        const cutA = la.findIndex((l) => /домофона|номер дома/i.test(l)), startB = lb.findIndex((l) => /наименован|сч[её]та/i.test(l));
        if (cutA >= 0 && startB >= 0) {
          data = { text: la.slice(0, cutA + 1).concat(lb.slice(startB)).join('\n'), confidence: Math.min(a.confidence, b.confidence) };
          lines = lineBoxes(a).filter((l) => l.y1 <= yBot + 4).concat(lineBoxes(b).map((l) => Object.assign(l, { y0: l.y0 + yBot, y1: l.y1 + yBot })).filter((l) => l.y0 >= yBot));
          T.mode = 2;
        }
      } catch (e) { /* второй поток не запустился — читаем одним */ }
    }
    const w0 = opt.worker || 0; // в каком потоке читать одиночным проходом
    if (!data) { if (headP) await headP; headP = null; data = await ocr(canvas, opt.params, w0); lines = lineBoxes(data); T.mode = 1; }
    T.ocr = performance.now() - t;
    let idText = '';
    if (!ID_RE.test(data.text)) { // «ID счета» напечатан мелко — читаем полосу над шапкой таблицы отдельно, крупнее
      t = performance.now();
      const head = lines.find((l) => /наименован/i.test(l.text));
      const y1 = head ? head.y0 : Math.round(canvas.height * 0.5), y0 = Math.max(0, y1 - Math.round(canvas.height * 0.1));
      if (y1 - y0 > 10) idText = (await ocr(crop(canvas, 0, y0, canvas.width * 0.55, y1 - y0, 2), opt.params, w0)).text;
      if (!ID_RE.test(idText) && 'BarcodeDetector' in window) {
        try { const v = (await new window.BarcodeDetector().detect(canvas)).map((x) => x.rawValue).find((x) => /^\d{5,8}$/.test(x)); if (v) idText += '\nсчета: ' + v; } catch (e) {}
      }
      T.id = performance.now() - t;
    }
    const text = data.text, sheet = parseSheet(text, idText), match = matchSheet(sheet, items);
    // Сверяем основное чтение с контрольным: ФИО, дата рождения, телефон (ошибку в букве сумма «Итого» не поймает)
    const hc = headP ? await headP : await headerCheck(canvas, lines, opt.params, w0);
    let fioConf = hc ? hc.conf1 : null, fioCheck = 'none';
    const check = { dob: 'none', phone: 'none' };
    if (hc) {
      const str = (f) => [f.last, f.first, f.middle].filter(Boolean).join(' ');
      if (hc.fio.last && hc.fio.first) {
        if (!sheet.last) { fioCheck = 'second'; sheet.last = hc.fio.last; sheet.first = hc.fio.first; sheet.middle = hc.fio.middle; fioConf = hc.conf2; } // основное чтение не дало ФИО
        else if (str(sheet).toLowerCase() === str(hc.fio).toLowerCase()) { fioCheck = 'same'; fioConf = Math.max(fioConf || 0, hc.conf2); }           // два чтения совпали
        else { fioCheck = 'diff'; sheet.fioAlt = str(hc.fio); }                                                                                     // расходятся — покажем оба
      }
      ['dob', 'phone'].forEach((k) => {
        const v = hc.sheet[k]; if (!v) return;
        if (!sheet[k]) { sheet[k] = v; check[k] = 'second'; } else if (sheet[k] === v) check[k] = 'same'; else { check[k] = 'diff'; sheet[k + 'Alt'] = v; }
      });
      if (!sheet.sex && hc.sheet.sex) sheet.sex = hc.sheet.sex;
      T.check = hc.ms;
    }
    T.pass = performance.now() - t0;
    return { canvas, lines, data, text, sheet, match, idText, fioConf, fioCheck, check, srcLong, warped, T };
  }
  const miss = (m) => (m.total ? Math.abs(m.total - m.sum) : 1e12) - m.items.length;
  // Повторы таблицы крупнее, пока сумма не сошлась с «Итого»
  async function finish(r, items, opt, say, fits) {
    const { canvas, lines, data, idText } = r;
    let { text, sheet, match } = r, passes = 1;
    const t = performance.now();
    for (const zoom of opt.zooms) {
      if (match.ok) break;
      if (fits && !fits(r.T.pass * 0.55)) break; // повтор таблицы ≈ половина полного чтения — не влезает в отведённое время

      say(0.92, 'retry');
      const t2 = await rescanTable({ canvas, lines, text: data.text }, zoom, opt.params, opt.worker || 0); if (!t2) break;
      passes++;
      const sh2 = parseSheet(t2, idText), m2 = matchSheet(sh2, items);
      if (m2.ok || miss(m2) < miss(match)) { Object.keys(sheet).forEach((k) => { if (k !== 'rows' && k !== 'totals' && !sh2[k]) sh2[k] = sheet[k]; }); sheet = sh2; match = m2; text = t2; }
    }
    if (passes > 1) r.T.retry = performance.now() - t;
    return Object.assign(r, { text, sheet, match, passes });
  }
  async function read(file, items, onProgress, optIn) {
    const opt = Object.assign({}, CFG, optIn || {}), t0 = performance.now();
    progressCb = onProgress || null;
    const say = (p, st) => { if (onProgress) onProgress(p, st); };
    // Время ограничено: медсестра ждёт результат не дольше ~15 с. Повторы делаются, только пока укладываемся;
    // не успели — показываем лучшее, что прочитали, с ошибками красным (можно переснять).
    const deadline = t0 + opt.budget, fits = (ms) => performance.now() + ms <= deadline;
    const pair = opt.pair === 'force' || (opt.pair !== false && canPair());
    let r = await readPass(file, items, opt);
    const better = (a, b) => (b.match.ok && !a.match.ok) || (!a.match.ok && miss(b.match) < miss(a.match)) ? b : a;
    if (!r.match.ok && r.warped && pair) {
      // Два потока: первый перечитывает таблицу выпрямленного листа крупнее, второй в это же время читает лист с обычной обрезкой.
      // Сначала готовый удачный результат — сразу показываем, не дожидаясь второго.
      say(0.9, 'retry');
      const a = finish(r, items, Object.assign({}, opt, { worker: 0 }), say, fits);
      const b = fits(r.T.pass * 1.1) ? readPass(file, items, Object.assign({}, opt, { warp: false, split: false, worker: 1 })).then((x) => { x.passes = 1; return x; }).catch(() => null) : Promise.resolve(null);
      const first = await Promise.race([a.then((x) => ['a', x]), b.then((x) => ['b', x])]);
      if (first[1] && first[1].match.ok) r = first[1];
      else { const [ra, rb] = await Promise.all([a, b]); r = rb ? better(ra, rb) : ra; r.passes = (ra.passes || 1) + (rb ? 1 : 0); }
    } else {
      r = await finish(r, items, opt, say, fits);
      // Один поток: выпрямленный лист так и не сошёлся с «Итого» — читаем с обычной обрезкой, если успеваем
      if (!r.match.ok && r.warped && fits(r.T.pass * 0.9)) {
        say(0.9, 'retry');
        const r2 = await finish(await readPass(file, items, Object.assign({}, opt, { warp: false })), items, opt, say, fits);
        r2.passes += r.passes;
        r = better(r, r2); r.passes = r2.passes;
      }
    }
    const T = r.T; T.total = performance.now() - t0; T.warped = r.warped ? 1 : 0;
    say(1, 'done');
    return { sheet: r.sheet, match: r.match, text: r.text, confidence: r.data.confidence, fioConf: r.fioConf, fioCheck: r.fioCheck, check: r.check, srcLong: r.srcLong, passes: r.passes, timings: T };
  }
  // Повторное чтение только таблицы услуг, крупнее: помогает, когда строка не прочиталась с общего снимка
  async function rescanTable(res, zoom, params, worker) {
    const c = res.canvas, L = res.lines || []; if (!c) return null;
    const top = L.filter((l) => /домофона|номер дома|сч[её]та/i.test(l.text)).pop();
    const head = L.find((l) => /наименован|покрыти|скидка/i.test(l.text));
    const bot = L.find((l) => /^.{0,6}итого/i.test(l.text.trim()));
    const y0 = Math.max(0, (head ? head.y0 : top ? top.y1 : Math.round(c.height * 0.45)) - 6);
    const y1 = Math.min(c.height, (bot ? bot.y0 : Math.round(c.height * 0.85)) + 4);
    if (y1 - y0 < 40) return null;
    const tableText = (await ocr(crop(c, 0, y0, c.width, y1 - y0, Math.min(zoom || 1.6, 4200 / c.width)), params, worker || 0)).text;
    // собираем текст заново: шапка листа + таблица + итоги
    const all = res.text.split(/\r?\n/);
    const hi = all.findIndex((l) => /адрес\s+вы[еe]зда/i.test(l)), ti = all.findIndex((l) => /^.{0,6}итого/i.test(l.trim()));
    const headPart = all.slice(0, hi >= 0 ? hi + 3 : Math.round(all.length * 0.4)).filter((l) => !/наименован/i.test(l));
    const tableLines = tableText.split(/\r?\n/).filter((l) => !/наименован/i.test(l) && !/^.{0,6}итого/i.test(l.trim()));
    return headPart.concat(['Наименование услуги'], tableLines, ti >= 0 ? all.slice(ti) : []).join('\n');
  }
  // Заранее загружаем и запускаем модуль распознавания: первое сканирование не ждёт, и всё остаётся в кэше для работы без сети
  function warmup() { getWorker(0).then(() => { if (canPair()) return getWorker(1); }).catch(() => {}); }
  return { norm, dice, parseSheet, matchSheet, read, warmup, frameInfo, sharpness, sameBox, paperQuad, homography };
})();
if (typeof module !== 'undefined') module.exports = Scan;
