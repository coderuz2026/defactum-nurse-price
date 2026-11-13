// Проверка расчётов: вытаскиваем функции из index.html и гоняем на реальном прайсе
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const src = html.match(/<script>\n'use strict';([\s\S]*?)<\/script>/)[1];
const store = {};
const Scan = require('../scan.js');
const stub = { Scan, btoa: (x) => Buffer.from(x, 'binary').toString('base64'), location: { protocol: 'https:', hostname: 'example.org' }, sessionStorage: {}, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  document: { documentElement: { classList: { contains: () => true, add() {} } }, addEventListener() {}, getElementById: () => ({ innerHTML: '', addEventListener() {}, remove() {} }), querySelectorAll: () => [], querySelector: () => null, body: { appendChild() {} }, createElement: () => ({ remove() {} }) },
  window: { scrollTo() {}, scrollY: 0, addEventListener() {}, Capacitor: null }, navigator: { userAgent: '' }, fetch: async () => ({ ok: false }), setTimeout, clearTimeout, console, Date, Math, JSON };
const fn = new Function(...Object.keys(stub), src + '\nreturn {shiftBits, pMissedIds, pMiss, deliveryInfo, DELIVERY, labelData, vTubes, prepFor, prepList, SETS, setItems, dayReport, dayKey, closeVisit, vSum, reportText, receiptLines, vHistory, vCatalog, PAY, tubeArt, priceDate, goBack, updateResult, printerBytes, b64, vPrinter, vClient, vVisit, vProfile, vScan, UI, verNum, APP_VERSION, scanProblems, fioShort, formatAddress, S, P, setPrices, vTotals, pSum, groupTubes, fmt, plural, newVisit, tubesFor, TUBES};');
const A = fn(...Object.values(stub));
const prices = JSON.parse(fs.readFileSync('data/prices.json', 'utf8'));
A.setPrices(prices);
let fail = 0; const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fail++; console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`)); };
const id = (re) => { const it = prices.items.find((x) => re.test(x.name)); if (!it) throw new Error('no item ' + re); return it; };
const ttg = id(/^Тиреотропный гормон ТТГ/), t4 = id(/^Свободный Т4/), oak = id(/^Общий анализ крови развернутый \(XN/), oam = id(/^Автоматизированный развернутый общий анализ мочи/), homa = id(/^HOMA/), alt = id(/^Аланин-аминотрансфераза \(/);
// 1. все цены — целые положительные, id уникальны
eq('все цены целые > 0', prices.items.every((x) => Number.isInteger(x.price) && x.price > 0), true);
eq('id уникальны', new Set(prices.items.map((x) => x.id)).size, prices.items.length);
eq('у каждой услуги есть категория', prices.items.every((x) => A.P.catById[x.cat]), true);
// 2. сумма пациента и выезда
const v = A.newVisit();
const p1 = { id: 'a', last: 'Р', first: 'А', items: [ttg.id, t4.id, oak.id, oam.id, homa.id, alt.id] };
const p2 = { id: 'b', last: 'Р', first: 'М', items: [oak.id, ttg.id] };
v.patients.push(p1, p2);
const s1 = ttg.price + t4.price + oak.price + oam.price + homa.price + alt.price, s2 = oak.price + ttg.price;
eq('сумма пациента 1', A.pSum(p1), s1);
eq('сумма пациента 2', A.pSum(p2), s2);
eq('итог без выезда и скидки', A.vTotals(v), { an: s1 + s2, ex: 0, off: 0, miss: 0, fee: 0, total: s1 + s2 });
v.homeFee = 150000;
eq('итог с выездом', A.vTotals(v).total, s1 + s2 + 150000);
v.discount = 10;
eq('скидка 10% только на анализы', A.vTotals(v), { an: s1 + s2, ex: 0, off: Math.round((s1 + s2) * 0.1), miss: 0, fee: 150000, total: s1 + s2 - Math.round((s1 + s2) * 0.1) + 150000 });
v.discount = 15; const t15 = A.vTotals(v);
eq('скидка 15%: сумма сходится', t15.an - t15.off + t15.fee, t15.total);
// 3. удалённая из прайса услуга не ломает расчёт
p2.items.push(99999999);
eq('неизвестный id = 0 сум', A.pSum(p2), s2);
// 4. перебор: сумма всех 618 услуг
const all = { id: 'c', items: prices.items.map((x) => x.id) };
eq('сумма всего прайса', A.pSum(all), prices.items.reduce((s, x) => s + x.price, 0));
// 5. пробирки: одинаковый контейнер у пациента = один штрихкод
const prl = id(/^Пролактин/), lh = id(/^Лютеинизирующий/);
const g = A.groupTubes(p1);
eq('6 анализов → 4 пробирки', g.map((x) => x.no), [1, 2, 7, 35]);
eq('Т4 свободный, АЛТ и HOMA — одна пробирка (35)', g.find((x) => x.no === 35).tests.length, 3);
eq('ТТГ и HOMA — одна пробирка (02)', g.find((x) => x.no === 2).tests.length, 2);
eq('HOMA в двух пробирках (02 и 35)', g.filter((x) => x.tests.some((n) => /^HOMA/.test(n))).map((x) => x.no), [2, 35]);
eq('штрихкоды уникальны', new Set(g.map((x) => x.code)).size, g.length);
eq('штрихкод = заказ + номер контейнера', g.map((x) => x.code), [1, 2, 7, 35].map((n) => String(p1.order) + String(n).padStart(2, '0')));
eq('штрихкод 8 цифр', g.every((x) => /^\d{8}$/.test(x.code)), true);
eq('штрихкод не меняется при повторе', A.groupTubes(p1).map((x) => x.code), g.map((x) => x.code));
const before = g.find((x) => x.no === 2).code;
p1.items.push(prl.id, lh.id);
const g2 = A.groupTubes(p1);
eq('+2 гормона: пробирок по-прежнему 4', g2.length, 4);
eq('+2 гормона: штрихкод (02) тот же', g2.find((x) => x.no === 2).code, before);
eq('+2 гормона: в (02) теперь 4 анализа', g2.find((x) => x.no === 2).tests.length, 4);
p1.items = p1.items.filter((x) => x !== oak.id);
eq('убрали ОАК: пробирка (01) исчезла', A.groupTubes(p1).map((x) => x.no), [2, 7, 35]);
p1.items.push(oak.id);
eq('вернули ОАК: штрихкод (01) прежний', A.groupTubes(p1).find((x) => x.no === 1).code, g.find((x) => x.no === 1).code);
p1.items.push(oak.id);
eq('у другого пациента свои штрихкоды', A.groupTubes(p2).some((x) => A.groupTubes(p1).map((y) => y.code).includes(x.code)), false);
// каждая услуга прайса попадает хотя бы в один известный контейнер
eq('у всех 618 услуг есть контейнер', prices.items.every((it) => { const k = A.tubesFor(it, A.P.catById[it.cat].name); return k.length && k.every((x) => A.TUBES[x]); }), true);
eq('номера контейнеров не повторяются', new Set(Object.values(A.TUBES).map((x) => x.no)).size, Object.keys(A.TUBES).length);
// адрес из ответа геокодера
eq('адрес: улица, дом, район', A.formatAddress({ address: { road: 'улица Авлиё-Ота', house_number: '1', city_district: 'Мирабадский район', city: 'Ташкент' } }), 'улица Авлиё-Ота, 1, Мирабадский район');
eq('адрес: только махалля', A.formatAddress({ address: { neighbourhood: 'махалля Олмазор', city: 'Ташкент' } }), 'махалля Олмазор');
eq('адрес: только город', A.formatAddress({ address: { city: 'Ташкент' } }), 'Ташкент');
eq('адрес: пустой ответ', A.formatAddress({}), '');
// 7. лист заказа Aurora: разбор распознанного текста (данные вымышленные, шумы как у настоящего OCR)
const SHEET = [
  'А де factum', '| ИДИ',
  'ФИО: Каримова Лола Тахировна 1D пациента: 123456',
  'Пол: Женщина Дата заказа: 11.11.2026',
  'Дата рождения: 06,04.1992 Время вызова: 06:30-08:00',
  'Номер телефона: +998 901112233 Бригада: ей у =',
  'Номер телефона 2: —————', 'Адрес; =',
  'Адрес выезда: Чиланзарский район, 5 квартал, дом 10, Квартира 7',
  'Ориентир:', 'Комментарии: позвонить за 10 минут',
  'Номер дома Номер квартиры Этаж Код домофона',
  '№ Наименование услуги Kon-so Сумма в т.ч НДС Скидка Сумма к Покрытие', 'оплате',
  '-— НОНО ННОНННН ООН НО НЩЕ ВОЕН',
  'Щелочная фосфотаза (Акайпе 1.0 50090.00 О 50000.90 Пациент', 'Phosphatase)',
  '2 Ферритин (Ferritin) 1.0 15000C.00 [о] 150000.0 Пациент',
  '$ Тиреотропный гормон TTT (TSH 1.0 100000.00 о 109009.0 Пациент', '3 Generation)',
  '4 C- реактивный белок (C-Reactive 1.0 70000.00 Го] 70000.0 Пациент', 'Protein) сн',
  '3 Свободный T4 (Free T4) 1.0 100000.00 © 100000.0 Пациент',
  '5 Свободный 13 (Free 13} 10 100000.00 0 100000.0 Пациент',
  '1оОбщий анализ крови развернутый 10 BCO00.00 0 B0000.0 Пациент', '[XN-10C0, Sysmex, Япония)',
  '3 Коезэтинин (Creatinine) 1.0 50009.00 0 50000.0 Пациент',
  '1 НОМА Оценка 1.0 180000.00 0 180000.0 Пациёнт', 'инсулинорезистентиости; глюкоза', '(натощак), инсулин (натощак), расчет', 'индекса ВОМАНВ',
  '2 Вызов на дом 1.0 в0090.00 о 80000.90 Пациент',
  'Итого: 960 000', 'Скидки: О', 'Сумма к оплате: 960 000'
].join('\n');
const sh = Scan.parseSheet(SHEET, '| 1D счета: 123987');
eq('лист: ФИО', [sh.last, sh.first, sh.middle], ['Каримова', 'Лола', 'Тахировна']);
eq('лист: пол, дата рождения, телефон', [sh.sex, sh.dob, sh.phone], ['f', '06.04.1992', '901112233']);
eq('лист: ID пациента и ID счёта', [sh.pid, sh.order], ['123456', '123987']);
eq('лист: адрес и время', [sh.address, sh.callTime, sh.orderDate], ['Чиланзарский район, 5 квартал, дом 10, Квартира 7', '06:30-08:00', '11.11.2026']);
eq('лист: 10 строк услуг', sh.rows.length, 10);
const mt = Scan.matchSheet(sh, prices.items);
eq('лист: 8 анализов найдены в прайсе', mt.items.map((x) => x.name.split(' (')[0].slice(0, 22)), ['Щелочная фосфотаза', 'Ферритин', 'Тиреотропный гормон ТТ', 'С- реактивный белок', 'Свободный Т4', 'Свободный Т3', 'Общий анализ крови раз', 'Креатинин'].concat(['HOMA Оценка инсулиноре']).slice(0, 9).filter((_, i) => i < mt.items.length));
eq('лист: анализов 9', mt.items.length, 9);
eq('лист: «Вызов на дом» отдельной строкой, 80 000', mt.extra, [{ name: 'Вызов на дом', price: 80000, sure: true, raw: '2 Вызов на дом 1.0 в0090.00 о 80000.90 Пациент' }]);
eq('лист: сумма сошлась с «Итого»', [mt.total, mt.sum, mt.ok], [960000, 960000, true]);
// лист → пациент → пробирки и штрихкоды
const p3 = { id: 'c3', last: sh.last, first: sh.first, middle: sh.middle, pid: sh.pid, order: Number(sh.order), items: mt.items.map((x) => x.id), extra: mt.extra.map((x) => ({ name: x.name, price: x.price })) };
eq('лист: сумма пациента = итог листа', A.pSum(p3), 960000);
const g3 = A.groupTubes(p3);
eq('лист: контейнеры 01, 02, 35', g3.map((x) => x.no), [1, 2, 35]);
eq('лист: штрихкод = ID счёта + контейнер', g3.map((x) => x.code), ['12398701', '12398702', '12398735']);
eq('лист: подпись на этикетке', A.fioShort(p3), 'Каримова Л.Т.');
const v2 = A.newVisit(); v2.patients.push(p3); v2.discount = 10;
eq('скидка не трогает «Вызов на дом»', A.vTotals(v2), { an: 880000, ex: 80000, off: 88000, miss: 0, fee: 0, total: 872000 });
// ошибки распознавания показываются списком
const lv = (x) => x.map((y) => y.level + ':' + y.text.split(/[:—(«]/)[0].trim());
eq('ошибки: чистый лист — нет ошибок', A.scanProblems({ sheet: sh, match: mt, sheetTotal: mt.total, confidence: 70, srcLong: 3000 }), []);
const shB = Scan.parseSheet(SHEET.replace(/\n2 Ферритин[^\n]*/, '').replace('Каримова Лола Тахировна', ''), ''), mB = Scan.matchSheet(shB, prices.items);
eq('ошибки: нет ФИО, сумма, ID счёта', lv(A.scanProblems({ sheet: shB, match: mB, sheetTotal: mB.total, confidence: 40, srcLong: 720 })).filter((x) => x.startsWith('err')),
  ['err:Фото слишком маленькое', 'err:Текст читается плохо', 'err:Не прочитано ФИО пациента', 'err:Сумма не сошлась', 'err:Не прочитан ID счёта']);
eq('ошибки: пропущенная строка — сколько не хватает', A.scanProblems({ sheet: shB, match: mB, sheetTotal: mB.total }).find((x) => /Сумма/.test(x.text)).text, 'Сумма не сошлась: на листе 960 000 сум, распознано 810 000 сум — не хватает 150 000 сум (пропущена строка)');
const mE = Scan.matchSheet(Scan.parseSheet('какой-то текст', ''), prices.items);
eq('ошибки: не лист', lv(A.scanProblems({ sheet: Scan.parseSheet('какой-то текст', ''), match: mE, sheetTotal: null })).slice(0, 2), ['err:Не прочитано ФИО пациента', 'err:Анализы не распознаны']);
const mV = Scan.matchSheet(Scan.parseSheet(SHEET.replace('2 Вызов на дом 1.0 в0090.00 о 80000.90', 'я бозовнадом 10 80000.00 0 80000.0'), ''), prices.items);
eq('«бозовнадом» распознаётся как «Вызов на дом»', [mV.extra.map((x) => x.name + ' ' + x.price), mV.ok], [['Вызов на дом 80000'], true]);
eq('ошибки: два чтения ФИО разошлись', lv(A.scanProblems({ sheet: Object.assign({}, sh, { fioAlt: 'Каримева Лола Тахировна' }), match: mt, sheetTotal: mt.total, fioCheck: 'diff', check: { dob: 'same', phone: 'diff' } })), ['err:ФИО прочитано двумя способами по-разному', 'err:Телефон прочитан по-разному']);
eq('ошибки: ФИО не перепроверено — предупреждение', lv(A.scanProblems({ sheet: sh, match: mt, sheetTotal: mt.total, fioCheck: 'none' })), ['warn:ФИО не удалось перепроверить']);
eq('ФИО: метка и обрывки отбрасываются', ['Фис Каримова Лола Тахировна', 'ФИО: Нназарова Дилноза Рустамовна | 1D пациента: 123456', 'DUNO: Юсупова Севара Бахтияровна Пе'].map((l) => { const r = Scan.parseSheet(l + '\nПол: Женщина', ''); return [r.last, r.first, r.middle].join(' '); }), ['Каримова Лола Тахировна', 'Назарова Дилноза Рустамовна', 'Юсупова Севара Бахтияровна']);
// экраны отрисовываются без ошибок (в т.ч. «Показать клиенту» с пациентом с листа и строкой «Вызов на дом»)
A.S.me = { name: 'Рахимова Нигора', branch: 'DeFactum Central', phone: '901234567' };
const draw = (f) => { try { return f(); } catch (e) { return 'ОШИБКА: ' + e.message; } };
const cl = draw(A.vClient);
eq('экран клиента: рисуется, есть анализы, «Вызов на дом» и итог', [/ОШИБКА/.test(cl), /Ферритин/.test(cl), /Вызов на дом/.test(cl), /872 000/.test(cl)], [false, true, true, true]);
eq('экран выезда рисуется', /ОШИБКА/.test(draw(A.vVisit)), false);
eq('экран профиля рисуется', /ОШИБКА/.test(draw(A.vProfile)), false);
A.UI.scan = { sheet: sh, match: mt, sheetTotal: mt.total, text: '', fioCheck: 'same', check: {} };
eq('экран проверки листа рисуется', /ОШИБКА/.test(draw(A.vScan)), false);
eq('экран принтера рисуется', /ОШИБКА/.test(draw(A.vPrinter)), false);
// команды принтера: этикетка 320×240 точек, первая точка чёрная
const fakeCanvas = { width: 320, height: 240, getContext: () => ({ getImageData: () => { const d = new Uint8Array(320 * 240 * 4).fill(255); d[0] = d[1] = d[2] = 0; return { data: d }; } }) };
const tspl = A.printerBytes([fakeCanvas], { proto: 'tspl', invert: false, gap: 2 }), head = 'SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,40,240,0,';
eq('TSPL: заголовок, размер данных, конец', [Buffer.from(tspl.slice(0, head.length)).toString(), tspl.length, Buffer.from(tspl.slice(-13)).toString()], [head, head.length + 40 * 240 + 13, '\r\nPRINT 1,1\r\n']);
eq('TSPL: чёрная точка = бит 0', [tspl[head.length], tspl[head.length + 1]], [0x7F, 0xFF]);
const esc = A.printerBytes([fakeCanvas, fakeCanvas], { proto: 'escpos', invert: false, gap: 2 });
eq('ESC/POS: команда растра и размер', [Array.from(esc.slice(0, 10)), esc.length], [[0x1B, 0x40, 0x1D, 0x76, 0x30, 0, 40, 0, 240, 0], 2 * (10 + 9600 + 3)]);
eq('ESC/POS: чёрная точка = бит 1', [esc[10], esc[11]], [0x80, 0x00]);
eq('base64 без потерь', Buffer.from(A.b64(tspl), 'base64').equals(Buffer.from(tspl)), true);
// кнопка «Назад»: возврат по экранам, с главного — выход
const backFrom = (view, extra) => { Object.assign(A.UI, { view, q: '', authMode: 'login' }, extra || {}); const handled = A.goBack(); return [handled, A.UI.view]; };
eq('назад: пробирки → выезд', backFrom('tubes'), [true, 'visit']);
eq('назад: анализы → выезд', backFrom('catalog'), [true, 'visit']);
eq('назад: анализы с поиском → сначала очистить поиск', [backFrom('catalog', { q: 'ттг' }), A.UI.q], [[true, 'catalog'], '']);
eq('назад: экран клиента → выезд', backFrom('client'), [true, 'visit']);
eq('назад: принтер → профиль → выезд', [backFrom('printer'), backFrom('profile')], [[true, 'profile'], [true, 'visit']]);
eq('назад: проверка листа → выезд', backFrom('scan'), [true, 'visit']);
eq('назад: с главного экрана — выход из приложения', backFrom('visit'), [false, 'visit']);
eq('назад: регистрация → вход, со входа — выход', [backFrom('auth', { authMode: 'reg' }), A.UI.authMode, backFrom('auth')], [[true, 'auth'], 'login', [false, 'auth']]);
// пропажа строки должна быть заметна: сумма не сходится
const broken = Scan.matchSheet(Scan.parseSheet(SHEET.replace(/\n2 Ферритин[^\n]*/, ''), ''), prices.items);
eq('лист без одной строки: предупреждение', [broken.ok, broken.total, broken.sum], [false, 960000, 810000]);
eq('пустой текст не ломает разбор', Scan.matchSheet(Scan.parseSheet('', ''), prices.items).ok, false);
eq('версии сравниваются по числам', [A.verNum('1.14') > A.verNum('1.9'), A.verNum('2.0') > A.verNum('1.99'), A.verNum('1.14') > A.verNum('1.14')], [true, true, false]);
eq('номер версии совпадает с номером кэша в sw.js', 'df-nurse-v' + A.APP_VERSION.split('.')[1], fs.readFileSync('sw.js', 'utf8').match(/df-nurse-v\d+/)[0]);
eq('дата прайса с годом', A.priceDate(), prices.version.split('-').reverse().join('.'));
eq('дата прайса на экране выезда', new RegExp('Прайс ' + A.priceDate().replace(/\./g, '\\.')).test(draw(A.vVisit)), true);
eq('рисунки контейнеров: для каждого типа есть рисунок', Object.keys(A.TUBES).map((k) => { const svg = A.tubeArt(Object.assign({ key: k }, A.TUBES[k])); return /^<svg[\s\S]*<\/svg>$/.test(svg) && !/undefined|NaN/.test(svg); }).every(Boolean), true);
// 6. формат
eq('формат 855000', A.fmt(855000), '855 000 сум');
eq('формат 1234567', A.fmt(1234567), '1 234 567 сум');
eq('склонения', [1, 2, 5, 11, 21, 22, 25].map((n) => A.plural(n, 'анализ', 'анализа', 'анализов')), ['анализ', 'анализа', 'анализов', 'анализов', 'анализ', 'анализа', 'анализов']);
// ---- подготовка, наборы, история, отчёт, язык
const byId = (n) => prices.items.find((x) => x.id === n);
eq('подготовка: глюкоза', A.prepFor(byId(342)), 'Натощак 8–12 часов');
eq('подготовка: общий анализ мочи', A.prepFor(byId(684)), 'Утренняя моча, средняя порция');
eq('подготовка: суточная моча', A.prepFor(byId(678)), 'Суточная моча: сбор за 24 часа');
eq('подготовка: кортизол', A.prepFor(byId(295)), 'Утром до 10:00, натощак');
eq('подготовка: аллерген — без подсказки', A.prepFor(byId(610)), '');
eq('подготовка: гликированный гемоглобин — без подсказки', A.prepFor(byId(468)), '');
eq('подготовка: мужчине не пишем про цикл', A.prepList({ sex: 'm', items: [492] }), []);
eq('подготовка: женщине пишем про цикл', A.prepList({ sex: 'f', items: [492] }).length, 1);
eq('все анализы готовых наборов есть в прайсе', A.SETS.every((x) => A.setItems(x).length === x.ids.length), true);
{
  A.S.me = { name: 'Тестова Нигора', phone: '901234567', branch: 'DeFactum Central' };
  const before = A.S.visits.length;
  const v1 = A.newVisit(); v1.patients.push({ id: 'h1', last: 'Каримова', first: 'Лола', sex: 'f', items: [342, 684], extra: [{ name: 'Вызов на дом', price: 80000 }] }); v1.pay = 'click'; v1.discount = 10;
  const sum1 = A.vTotals(v1).total;
  eq('выезд 1: скидка только на анализы', sum1, 130000 - 13000 + 80000);
  A.closeVisit(v1);
  const v2 = A.newVisit(); v2.patients.push({ id: 'h2', last: 'Юсупова', first: 'Малика', sex: 'f', items: [300], extra: [] });
  const r = A.dayReport(A.dayKey(Date.now()));
  const mine = r.visits.filter((x) => x.id === v1.id || x.id === v2.id);
  eq('отчёт: оба выезда попали в сегодняшний день', mine.length, 2);
  eq('отчёт: сумма дня = сумма выездов', r.total, r.visits.reduce((a, x) => a + A.vSum(x), 0));
  eq('отчёт: оплаты по видам в сумме дают итог', Object.values(r.pay).reduce((a, x) => a + x, 0), r.total);
  eq('отчёт: Click учтён', r.pay.click >= sum1, true);
  eq('закрытый выезд помнит свою сумму при смене цены', (() => { const it = byId(342), old = it.price; it.price = 999999; const s = A.vSum(v1); it.price = old; return s; })(), sum1);
  eq('пустой выезд в отчёт не попадает', (() => { const n = A.dayReport(A.dayKey(Date.now())).visits.length; A.newVisit(); const m = A.dayReport(A.dayKey(Date.now())).visits.length; return m - n; })(), 0);
  A.S.visitId = v1.id;
  const L = A.receiptLines(v1);
  eq('чек: итог совпадает с расчётом', L.find((x) => x.k === 'total').r, A.fmt(sum1));
  eq('чек: есть строка оплаты', L.some((x) => x.r === 'Click'), true);
  eq('текст отчёта содержит итог', A.reportText(r).includes(A.fmt(r.total)), true);
  eq('экран истории рисуется', /Итого за день/.test(A.vHistory()), true);
  A.UI.patientId = 'h1'; A.UI.cat = -1; eq('экран наборов рисуется', /Наборы анализов/.test(A.vCatalog()), true); A.UI.cat = 0;
}
// ---- забор: взято / не удалось / доставка
{
  A.S.me = A.S.me || { name: 'Тестова Нигора', phone: '901234567', branch: 'DeFactum Central' };
  const v = A.newVisit(); A.S.visitId = v.id;
  const p = { id: 'z1', last: 'Каримова', first: 'Лола', sex: 'f', items: [892, 457, 342, 332], extra: [{ name: 'Вызов на дом', price: 80000 }] };
  v.patients.push(p);
  const tubes = A.groupTubes(p), full = A.vTotals(v);
  const ttg = tubes.find((t) => t.tests.some((n) => /^Тиреотропный/.test(n)));
  eq('ТТГ в отдельной пробирке', !!ttg && ttg.tests.length, 1);
  p.missed = { [ttg.key]: 'Пациент отказался' };
  const t2 = A.vTotals(v);
  eq('не взято: сумма анализов уменьшилась на цену ТТГ', full.an - t2.an, byId(457).price);
  eq('не взято: сумма невзятого = цена ТТГ', t2.miss, byId(457).price);
  eq('не взято: вызов на дом остался', t2.ex, 80000);
  v.discount = 10; const t3 = A.vTotals(v);
  eq('скидка считается только со взятых анализов', t3.off, Math.round(t2.an * 0.1));
  v.discount = 0;
  eq('пробирка помечена как невзятая', A.groupTubes(p).find((t) => t.key === ttg.key).missed, 'Пациент отказался');
  const L = A.receiptLines(v);
  eq('в чеке у невзятого анализа нет цены', L.some((x) => /^Тиреотропный/.test(x.l || '') && x.r === 'не взято'), true);
  eq('итог чека без невзятого', L.find((x) => x.k === 'total').r, A.fmt(t2.total));
  p.missed = {};
  eq('вернули пробирку — сумма как была', A.vTotals(v).total, full.total);
  // двойная пробирка: HOMA требует 35 и 02 — выпадает, если не взята любая
  const homa = prices.items.find((x) => /HOMA/i.test(x.name));
  if (homa) { const q = { id: 'z2', last: 'Т', first: 'Т', items: [homa.id], extra: [] }; const tt = A.groupTubes(q);
    eq('HOMA: две пробирки', tt.length, 2);
    q.missed = { [tt[1].key]: 'Не хватило материала' }; eq('HOMA выпадает без одной из пробирок', A.pMiss(q), homa.price); }
  // время забора на этикетке
  const at = new Date('2026-11-13T09:41:00').getTime(); p.taken = { [tubes[0].key]: at };
  eq('этикетка: время забора', (({ timeLabel, time }) => [timeLabel, time])(A.labelData(p, A.groupTubes(p)[0])), ['Взято', '13.11.2026 09:41']);
  eq('этикетка без отметки: время выезда', A.labelData(p, A.groupTubes(p)[1]).timeLabel, 'Выезд');
  eq('этикетка: полное ФИО и номер пробирки', (({ fio, no }) => [fio, no])(A.labelData(p, A.groupTubes(p)[0])), ['Каримова Лола', 1]);
  p.missed = { [tubes[0].key]: 'x' };
  eq('невзятая пробирка не считается взятой', A.groupTubes(p)[0].taken, 0);
  p.missed = {};
  // доставка
  eq('без сроков доставки — только «материал взят»', [!!A.deliveryInfo(v).first, A.deliveryInfo(v).due], [true, null]);
  A.DELIVERY[tubes[0].no] = 2; const d = A.deliveryInfo(v);
  eq('срок доставки = забор + 2 часа', d.due && d.due.at, at + 2 * 3600e3);
  delete A.DELIVERY[tubes[0].no];
  A.UI.patientId = 'z1'; p.missed = { [ttg.key]: 'Пациент отказался' };
  const html = A.vTubes();
  eq('экран пробирок: печать без невзятой', /Печать этикеток \(2\)/.test(html), true);
  eq('экран пробирок: кнопки Взято/Не удалось', /data-act="take"/.test(html) && /data-act="miss"/.test(html), true);
}
// ---- сдвиг печати
{
  const m = { bits: new Uint8Array(40 * 2), wb: 40, h: 2 }; m.bits[0] = 0x80; m.bits[40] = 0x80; // по чёрной точке в левом верхнем углу каждой строки
  const r = A.shiftBits(m, 24, 0, 344); eq('сдвиг вправо на 3 мм: точка уехала на 24 точки', [r.wb, r.bits[3], r.bits[3] & 0x80], [43, 0x80, 0x80]);
  const l = A.shiftBits(m, -8, 0, 320); eq('сдвиг влево: край обрезан', l.bits.every((b) => b === 0), true);
  const d = A.shiftBits(m, 0, 1, 320); eq('сдвиг вниз на 1 точку', [d.bits[0], d.bits[40]], [0, 0x80]);
  const W = A.printerBytes([fakeCanvas], { proto: 'escpos', invert: false, gap: 2, dx: 3 });
  eq('ESC/POS +3 мм: ширина картинки 43 байта', [W[6], W[7]], [43, 0]);
  eq('ESC/POS не шире головки 58 мм', A.printerBytes([fakeCanvas], { proto: 'escpos', gap: 2, dx: 8 })[6], 48);
  const Tp = Buffer.from(A.printerBytes([fakeCanvas], { proto: 'tspl', invert: false, gap: 2, dx: 3, dy: -1 })).toString('latin1');
  eq('TSPL +3 мм вправо: BITMAP 24,0', Tp.includes('BITMAP 24,0,40,240,0,'), true);
  eq('без сдвига команды не меняются', Buffer.from(A.printerBytes([fakeCanvas], { proto: 'tspl', invert: false, gap: 2, dx: 0, dy: 0 })).equals(Buffer.from(A.printerBytes([fakeCanvas], { proto: 'tspl', invert: false, gap: 2 }))), true);
}
console.log(fail ? `\nОШИБОК: ${fail}` : '\nВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(fail ? 1 : 0);
