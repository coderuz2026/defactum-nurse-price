// Проверка расчётов: вытаскиваем функции из index.html и гоняем на реальном прайсе
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const src = html.match(/<script>\n'use strict';([\s\S]*?)<\/script>/)[1];
const store = {};
const stub = { localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  document: { addEventListener() {}, getElementById: () => ({ innerHTML: '' }), querySelectorAll: () => [], querySelector: () => null, body: { appendChild() {} }, createElement: () => ({ remove() {} }) },
  window: { scrollTo() {}, scrollY: 0 }, navigator: {}, fetch: async () => ({ ok: false }), setTimeout, clearTimeout, console, Date, Math, JSON };
const fn = new Function(...Object.keys(stub), src + '\nreturn {S, P, setPrices, vTotals, pSum, groupTubes, fmt, plural, newVisit, tubesFor, TUBES};');
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
eq('итог без выезда и скидки', A.vTotals(v), { an: s1 + s2, off: 0, fee: 0, total: s1 + s2 });
v.homeFee = 150000;
eq('итог с выездом', A.vTotals(v).total, s1 + s2 + 150000);
v.discount = 10;
eq('скидка 10% только на анализы', A.vTotals(v), { an: s1 + s2, off: Math.round((s1 + s2) * 0.1), fee: 150000, total: s1 + s2 - Math.round((s1 + s2) * 0.1) + 150000 });
v.discount = 15; const t15 = A.vTotals(v);
eq('скидка 15%: сумма сходится', t15.an - t15.off + t15.fee, t15.total);
// 3. удалённая из прайса услуга не ломает расчёт
p2.items.push(99999999);
eq('неизвестный id = 0 сум', A.pSum(p2), s2);
// 4. перебор: сумма всех 618 услуг
const all = { id: 'c', items: prices.items.map((x) => x.id) };
eq('сумма всего прайса', A.pSum(all), prices.items.reduce((s, x) => s + x.price, 0));
// 5. пробирки
const g = A.groupTubes(p1);
eq('6 анализов → 4 пробирки', g.length, 4);
eq('ТТГ и Т4 в одной пробирке (02)', g.find((x) => x.no === 2).tests.filter((n) => /ТТГ|Т4/.test(n)).length, 2);
eq('HOMA в двух пробирках (02 и 35)', g.filter((x) => x.tests.some((n) => /^HOMA/.test(n))).map((x) => x.no).sort(), [2, 35]);
eq('штрихкоды уникальны', new Set(g.map((x) => x.code)).size, g.length);
eq('штрихкод не меняется при повторе', A.groupTubes(p1).map((x) => x.code), g.map((x) => x.code));
eq('у другого пациента свои штрихкоды', A.groupTubes(p2).some((x) => g.map((y) => y.code).includes(x.code)), false);
// 6. формат
eq('формат 855000', A.fmt(855000), '855 000 сум');
eq('формат 1234567', A.fmt(1234567), '1 234 567 сум');
eq('склонения', [1, 2, 5, 11, 21, 22, 25].map((n) => A.plural(n, 'анализ', 'анализа', 'анализов')), ['анализ', 'анализа', 'анализов', 'анализов', 'анализ', 'анализа', 'анализов']);
console.log(fail ? `\nОШИБОК: ${fail}` : '\nВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(fail ? 1 : 0);
