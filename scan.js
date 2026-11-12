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
  function moneyAfterColon(line) { // «Итого: 1 060 000»
    const m = line.split(':').slice(1).join(':'); if (!m) return null;
    const n = parseInt(fixDigits(m).replace(/[^\d]/g, ''), 10); return okPrice(n) ? n : null;
  }

  const mode = (a) => a.slice().sort((x, y) => a.filter((v) => v === y).length - a.filter((v) => v === x).length)[0]; // чаще встречающееся значение

  /* ---------- Разбор текста листа ---------- */
  const afterColon = (l) => l.slice(l.search(/[:;]/) + 1).trim();
  const cyrWords = (s) => (s.match(/[А-ЯЁа-яёЎўҚқҒғҲҳ'ʼ`-]{2,}/g) || []);
  function parseSheet(text, idText) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const L = lines.map((l) => l.toLowerCase());
    const r = { last: '', first: '', middle: '', sex: '', dob: '', phone: '', pid: '', order: '', orderDate: '', callTime: '', address: '', comment: '', rows: [], totals: [] };
    const find = (re) => L.findIndex((l) => re.test(l));
    // ФИО и ID пациента стоят в одной строке
    let i = find(/пациента\s*[:;]?\s*\d{4,}/);
    if (i < 0) i = find(/^.{0,6}(фио|ф\.?и\.?о)/);
    if (i >= 0) {
      const line = lines[i];
      const idm = line.match(/пациента\s*[:;]?\s*(\d{4,8})/i); if (idm) r.pid = idm[1];
      const left = line.split(/\b[1I|Il]?[DО]?\s*пациента/i)[0];
      const w = cyrWords(afterColon(left)).filter((x) => !/^(фио|пациента)$/i.test(x));
      const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
      [r.last, r.first, r.middle] = [w[0] || '', w[1] || '', w.slice(2).join(' ')].map((x) => x.split(' ').map(cap).join(' ').trim());
    }
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
        const visit = /вызов\s*(на|ha)\s*дом|выезд/i.test(row.name);
        const clean = visit ? 'Вызов на дом' : (row.name + (row.more ? ' ' + row.more : '')).replace(/\s+/g, ' ').trim();
        if (clean.length >= 3) out.extra.push({ name: clean, price: row.price || 0, sure: !!row.price && visit, raw: row.raw });
      }
    });
    const sumItems = out.items.reduce((s, x) => s + x.price, 0);
    const sumAll = () => sumItems + out.extra.reduce((s, x) => s + x.price, 0);
    // Итог листа: значение, которое подтверждается суммой строк; иначе — первое прочитанное (тогда будет предупреждение).
    // Цены строк по итогу НЕ подгоняем: иначе пропущенная строка осталась бы незамеченной.
    const totals = sheet.totals || [];
    out.total = totals.find((t) => t === sumAll()) || totals[0] || null;
    out.sum = sumAll();
    out.ok = !!out.total && out.total === out.sum && out.items.length > 0;
    return out;
  }

  /* ---------- Распознавание в браузере (Tesseract, файлы лежат в vendor/tesseract) ---------- */
  const base = () => new URL('vendor/tesseract/', document.baseURI).href;
  let workerP = null, progressCb = null;
  function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Не загрузился модуль распознавания')); document.head.appendChild(s); }); }
  async function getWorker() {
    if (!workerP) workerP = (async () => {
      if (!window.Tesseract) await loadScript(base() + 'tesseract.min.js');
      return window.Tesseract.createWorker(['rus', 'eng'], 1, {
        workerPath: base() + 'worker.min.js', corePath: base(), langPath: base() + 'lang', gzip: true,
        logger: (m) => { if (progressCb && m.status) progressCb(m.status === 'recognizing text' ? 0.3 + 0.6 * m.progress : 0.05 + 0.25 * (m.progress || 0), m.status); }
      });
    })().catch((e) => { workerP = null; throw e; });
    return workerP;
  }
  async function toCanvas(file, opt) {
    opt = opt || {};
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('Не удалось открыть фото')); im.src = URL.createObjectURL(file); }); }
    const long = Math.max(bmp.width, bmp.height), k = Math.min(3.2, Math.max(0.3, (opt.long || 2600) / long));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
    g.filter = opt.filter || 'grayscale(1)'; g.drawImage(bmp, 0, 0, c.width, c.height); g.filter = 'none';
    if (opt.norm !== false) {
      // Выравниваем освещение: делим на размытую «карту бумаги», чтобы тени и блики не мешали чтению
      const sw = Math.max(8, Math.round(c.width / 40)), sh = Math.max(8, Math.round(c.height / 40));
      const small = document.createElement('canvas'); small.width = sw; small.height = sh;
      const sg = small.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(c, 0, 0, sw, sh);
      const bgc = document.createElement('canvas'); bgc.width = c.width; bgc.height = c.height;
      const bg = bgc.getContext('2d', { willReadFrequently: true }); bg.imageSmoothingQuality = 'high'; bg.drawImage(small, 0, 0, c.width, c.height);
      const img = g.getImageData(0, 0, c.width, c.height), d = img.data, bd = bg.getImageData(0, 0, c.width, c.height).data;
      const gamma = opt.gamma || 1.3;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.min(1, d[i] / (Math.max(40, bd[i]) * 0.97));
        const o = v >= 1 ? 255 : Math.round(255 * Math.pow(v, gamma));
        d[i] = d[i + 1] = d[i + 2] = o;
      }
      g.putImageData(img, 0, 0);
    }
    c._srcLong = long;
    return c;
  }
  async function recognize(file, onProgress, opt) {
    progressCb = onProgress || null;
    const canvas = await toCanvas(file, opt);
    const w = await getWorker();
    const { data } = await w.recognize(canvas);
    let idText = '';
    if (!/сч[её]та\s*[:;]?\s*\d{5,8}/i.test(data.text)) {
      // «ID счета» напечатан мелко — читаем полосу над шапкой таблицы отдельно, крупнее
      const head = (data.lines || []).find((l) => /наименован/i.test(l.text));
      const y1 = head ? head.bbox.y0 : Math.round(canvas.height * 0.5), y0 = Math.max(0, y1 - Math.round(canvas.height * 0.1));
      const c2 = document.createElement('canvas'); const k = 2; c2.width = Math.round(canvas.width * 0.55 * k); c2.height = (y1 - y0) * k;
      if (c2.height > 20) { c2.getContext('2d').drawImage(canvas, 0, y0, canvas.width * 0.55, y1 - y0, 0, 0, c2.width, c2.height); idText = (await w.recognize(c2)).data.text; }
      if (!/сч[её]та\s*[:;]?\s*\d{5,8}/i.test(idText) && 'BarcodeDetector' in window) {
        try { const codes = await new window.BarcodeDetector().detect(canvas); const d = codes.map((x) => x.rawValue).find((v) => /^\d{5,8}$/.test(v)); if (d) idText += '\nсчета: ' + d; } catch (e) {}
      }
    }
    if (onProgress) onProgress(1, 'done');
    return { text: data.text, idText, confidence: data.confidence, srcLong: canvas._srcLong, canvas, lines: (data.lines || []).map((l) => ({ text: l.text, y0: l.bbox.y0, y1: l.bbox.y1 })) };
  }
  // Повторное чтение только таблицы услуг, крупнее: помогает, когда строка не прочиталась с общего снимка
  async function rescanTable(res, zoom) {
    const c = res.canvas, L = res.lines || []; if (!c) return null;
    const top = L.filter((l) => /домофона|номер дома|сч[её]та/i.test(l.text)).pop();
    const head = L.find((l) => /наименован|покрыти|скидка/i.test(l.text));
    const bot = L.find((l) => /^.{0,6}итого/i.test(l.text.trim()));
    const y0 = Math.max(0, (head ? head.y0 : top ? top.y1 : Math.round(c.height * 0.45)) - 6);
    const y1 = Math.min(c.height, (bot ? bot.y0 : Math.round(c.height * 0.85)) + 4);
    if (y1 - y0 < 40) return null;
    const k = Math.min(zoom || 1.6, 4200 / c.width);
    const c2 = document.createElement('canvas'); c2.width = Math.round(c.width * k); c2.height = Math.round((y1 - y0) * k);
    const g = c2.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, c2.width, c2.height);
    g.drawImage(c, 0, y0, c.width, y1 - y0, 0, 0, c2.width, c2.height);
    const w = await getWorker();
    const tableText = (await w.recognize(c2)).data.text;
    // собираем текст заново: шапка листа + таблица + итоги
    const all = res.text.split(/\r?\n/);
    const hi = all.findIndex((l) => /адрес\s+вы[еe]зда/i.test(l)), ti = all.findIndex((l) => /^.{0,6}итого/i.test(l.trim()));
    const headPart = all.slice(0, hi >= 0 ? hi + 3 : Math.round(all.length * 0.4)).filter((l) => !/наименован/i.test(l));
    const tableLines = tableText.split(/\r?\n/).filter((l) => !/наименован/i.test(l) && !/^.{0,6}итого/i.test(l.trim()));
    return headPart.concat(['Наименование услуги'], tableLines, ti >= 0 ? all.slice(ti) : []).join('\n');
  }
  function warmup() { // заранее кладём модуль распознавания в кэш, чтобы работал без интернета
    try { ['tesseract.min.js', 'worker.min.js', 'lang/rus.traineddata.gz', 'lang/eng.traineddata.gz'].forEach((f) => fetch(base() + f).catch(() => {})); } catch (e) {}
  }
  return { norm, dice, parseSheet, matchSheet, recognize, rescanTable, warmup };
})();
if (typeof module !== 'undefined') module.exports = Scan;
