// Usage: BASE_URL=https://your-app.onrender.com API_KEY=secret node test.js
// WARNING: calls /reset, which wipes all bookings and slots.
const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.API_KEY;
if (!BASE || !KEY) { console.error('Set BASE_URL and API_KEY'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + extra}`);
};
async function call(method, path, body, headers = {}, key = KEY) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (key) h['X-API-Key'] = key;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, headers: r.headers };
}
const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const slot = (id, hrs) => ({ id, provider: 'Dr Ade', start: future(hrs), end: future(hrs + 0.5) });
let n = 0; const uniq = () => `user${Date.now()}${n++}@example.com`;
const book = (slot_id, email = uniq(), name = 'Ada Obi', headers = {}) => call('POST', '/bookings', { slot_id, name, email }, headers);

(async () => {
  // Setup
  const past = { id: 'past', provider: 'Dr Old', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' };
  let r = await call('POST', '/reset', { slots: [past, ...Array.from({ length: 12 }, (_, i) => slot('s' + (i + 1), 24 + i))] });
  ok('reset ok', r.status === 200, r.status);

  // Level 1
  r = await call('GET', '/slots');
  ok('list slots earliest first', r.status === 200 && r.json.slots[0].id === 'past' && r.json.slots.length === 13, JSON.stringify(r.json).slice(0, 120));
  ok('slots have available flag', r.json.slots.every((s) => typeof s.available === 'boolean'));
  r = await book('s1', '  ADA@Example.COM ', '  Ada Obi  ');
  ok('book -> 201 confirmed', r.status === 201 && r.json.status === 'confirmed', JSON.stringify(r));
  ok('name trimmed, email trimmed + lowercased', r.json.name === 'Ada Obi' && r.json.email === 'ada@example.com', JSON.stringify(r.json));
  const id = r.json.id;
  r = await call('GET', '/bookings/' + id);
  ok('get booking', r.status === 200 && r.json.id === id);
  r = await call('GET', '/bookings/nope');
  ok('get missing booking -> 404', r.status === 404 && r.json.error);
  r = await call('GET', '/slots');
  ok('booked slot unavailable', r.json.slots.find((s) => s.id === 's1').available === false);

  // Level 2
  r = await call('GET', '/slots', undefined, {}, null);
  ok('no key -> 401', r.status === 401 && r.json.error);
  r = await call('GET', '/slots', undefined, {}, 'wrong');
  ok('wrong key -> 401', r.status === 401);
  for (const [label, b] of [
    ['missing slot_id', { name: 'A', email: 'a@b.co' }],
    ['empty name', { slot_id: 's2', name: '   ', email: 'a@b.co' }],
    ['missing email', { slot_id: 's2', name: 'A' }],
    ['invalid email', { slot_id: 's2', name: 'A', email: 'not-an-email' }],
  ]) { r = await call('POST', '/bookings', b); ok('400 ' + label, r.status === 400 && r.json.error, r.status); }
  r = await book('does-not-exist'); ok('unknown slot -> 404', r.status === 404, r.status);
  r = await book('past'); ok('past slot -> 400', r.status === 400, r.status);

  // Level 3
  r = await book('s1'); ok('already booked -> 409', r.status === 409, r.status);
  const race = await Promise.all(Array.from({ length: 20 }, () => book('s2')));
  const codes = race.map((x) => x.status);
  ok('20 concurrent bookings: exactly one 201', codes.filter((c) => c === 201).length === 1, codes.join(','));
  ok('20 concurrent bookings: rest are 409', codes.filter((c) => c === 409).length === 19, codes.join(','));
  r = await call('DELETE', '/bookings/' + id);
  ok('cancel -> 200 cancelled', r.status === 200 && r.json.status === 'cancelled', JSON.stringify(r));
  r = await call('DELETE', '/bookings/' + id); ok('cancel twice -> 409', r.status === 409, r.status);
  r = await call('DELETE', '/bookings/nope'); ok('cancel missing -> 404', r.status === 404, r.status);
  r = await book('s1'); ok('cancelled slot can be rebooked', r.status === 201, r.status);

  // Level 4: idempotency
  const email = uniq(), body = { slot_id: 's3', name: 'Ife', email };
  const k = 'key-' + Date.now();
  const a = await call('POST', '/bookings', body, { 'Idempotency-Key': k });
  const b = await call('POST', '/bookings', body, { 'Idempotency-Key': k });
  ok('idempotent replay: same status + id', a.status === 201 && b.status === 201 && a.json.id === b.json.id, `${a.status}/${b.status}`);
  const c = await call('POST', '/bookings', { ...body, name: 'Other' }, { 'Idempotency-Key': k });
  ok('same key, different body -> 422', c.status === 422, c.status);
  const k2 = 'key2-' + Date.now(), e2 = uniq();
  const conc = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/bookings', { slot_id: 's4', name: 'X', email: e2 }, { 'Idempotency-Key': k2 })));
  ok('concurrent same key: one booking id', new Set(conc.map((x) => x.json.id)).size === 1 && conc.every((x) => x.status === 201), conc.map((x) => x.status).join(','));
  r = await call('GET', '/bookings?email=' + encodeURIComponent(e2));
  ok('retries created no duplicates', r.json.bookings.length === 1, r.json.bookings.length);

  // Level 4: pagination (5 bookings stays inside the rate limit)
  const pe = uniq();
  for (let i = 5; i <= 9; i++) await book('s' + i, pe);
  const seen = []; let cursor = null, pages = 0;
  do {
    r = await call('GET', `/bookings?email=${encodeURIComponent(pe.toUpperCase())}&limit=2` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    seen.push(...r.json.bookings.map((x) => x.slot_id)); cursor = r.json.next_cursor; pages++;
  } while (cursor && pages < 10);
  ok('pagination: 3 pages, 5 bookings, oldest first, no repeats',
    pages === 3 && seen.join() === 's5,s6,s7,s8,s9', `${pages} pages: ${seen}`);
  ok('last page next_cursor null', cursor === null);
  for (const l of ['0', '51', 'abc']) { r = await call('GET', `/bookings?email=x@y.co&limit=${l}`); ok('limit=' + l + ' -> 400', r.status === 400, r.status); }

  // Level 5
  const re = uniq(), results = [];
  for (let i = 0; i < 6; i++) results.push(await book('s10', re));
  ok('6th attempt in a minute -> 429', results[5].status === 429, results.map((x) => x.status).join(','));
  const ra = Number(results[5].headers.get('Retry-After'));
  ok('Retry-After is whole seconds (1-60)', Number.isInteger(ra) && ra >= 1 && ra <= 60, ra);
  r = await book('s11'); ok('other emails unaffected', r.status === 201, r.status);
  const fe = uniq(), fr = [];
  for (let i = 0; i < 6; i++) fr.push(await call('POST', '/bookings', { slot_id: 'nope', name: 'A', email: fe }));
  ok('failed attempts count toward limit', fr[5].status === 429 && fr.slice(0, 5).every((x) => x.status === 404), fr.map((x) => x.status).join(','));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();