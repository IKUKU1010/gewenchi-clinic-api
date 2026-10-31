const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const API_KEY = process.env.API_KEY;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // public web page (no key needed)

const err = (res, code, msg) => res.status(code).json({ error: msg });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL,
      start_text TEXT NOT NULL, end_text TEXT NOT NULL, start_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings (
      seq BIGSERIAL UNIQUE, id TEXT PRIMARY KEY,
      slot_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    -- the guarantee for level 3: only one confirmed booking per slot, enforced by the DB
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot ON bookings(slot_id) WHERE status='confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email ON bookings(email, seq);
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, status INT NOT NULL, response JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (
      id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), allowed BOOLEAN NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts(email, at);
  `);
}

// Level 2: API key
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/health') return next();
  if (!API_KEY || req.get('X-API-Key') !== API_KEY) return err(res, 401, 'invalid or missing API key');
  next();
});
app.get('/health', (_, res) => res.json({ ok: true }));

const bookingOut = (b) => ({
  id: b.id, slot_id: b.slot_id, name: b.name, email: b.email,
  status: b.status, created_at: new Date(b.created_at).toISOString(),
});

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Level 1: reset
app.post('/reset', async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return err(res, 400, 'slots must be an array');
  for (const s of slots) {
    if (!s || ['id', 'provider', 'start', 'end'].some((k) => typeof s[k] !== 'string' || !s[k]) || isNaN(Date.parse(s.start)))
      return err(res, 400, 'each slot needs id, provider, start, end');
  }
  await tx(async (c) => {
    await c.query('TRUNCATE bookings, slots, idempotency, attempts');
    for (const s of slots)
      await c.query('INSERT INTO slots(id,provider,start_text,end_text,start_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET provider=$2,start_text=$3,end_text=$4,start_at=$5',
        [s.id, s.provider, s.start, s.end, s.start]);
  });
  res.json({ ok: true, slots: slots.length });
});

app.get('/slots', async (_, res) => {
  const { rows } = await pool.query(`
    SELECT s.*, NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id=s.id AND b.status='confirmed') AS available
    FROM slots s ORDER BY s.start_at, s.id`);
  res.json({ slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: r.start_text, end: r.end_text, available: r.available })) });
});

// Level 5: per-email rate limit (5 / minute, failures included), safe under concurrency via advisory lock
async function rateLimit(email) {
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl:' + email]);
    await c.query(`DELETE FROM attempts WHERE at < now() - interval '5 minutes'`);
    const { rows } = await c.query(
      `SELECT EXTRACT(EPOCH FROM (min(at) + interval '60 seconds' - now())) AS wait, count(*)::int AS n
       FROM attempts WHERE email=$1 AND allowed AND at > now() - interval '60 seconds'`, [email]);
    const allowed = rows[0].n < 5;
    await c.query('INSERT INTO attempts(email, allowed) VALUES($1,$2)', [email, allowed]);
    return allowed ? 0 : Math.max(1, Math.ceil(Number(rows[0].wait)));
  });
}

const stable = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

async function createBooking(c, body) {
  const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!slotId) return [400, { error: 'slot_id is required' }];
  if (!name) return [400, { error: 'name is required' }];
  if (!email) return [400, { error: 'email is required' }];
  if (!EMAIL_RE.test(email)) return [400, { error: 'email is invalid' }];
  const s = (await c.query('SELECT * FROM slots WHERE id=$1', [slotId])).rows[0];
  if (!s) return [404, { error: 'slot not found' }];
  if (new Date(s.start_at) <= new Date()) return [400, { error: 'slot has already started' }];
  const id = crypto.randomUUID();
  const r = await c.query(
    `INSERT INTO bookings(id,slot_id,name,email,status) VALUES($1,$2,$3,$4,'confirmed')
     ON CONFLICT (slot_id) WHERE status='confirmed' DO NOTHING RETURNING *`, [id, slotId, name, email]);
  if (!r.rows.length) return [409, { error: 'slot already booked' }];
  return [201, bookingOut(r.rows[0])];
}

app.post('/bookings', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email) {
    const wait = await rateLimit(email);
    if (wait) { res.set('Retry-After', String(wait)); return err(res, 429, 'too many attempts, slow down'); }
  }
  const key = req.get('Idempotency-Key');
  const [status, payload] = await tx(async (c) => {
    if (!key) return createBooking(c, body);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['idem:' + key]);
    const hash = crypto.createHash('sha256').update(stable(body)).digest('hex');
    const ex = (await c.query('SELECT * FROM idempotency WHERE key=$1', [key])).rows[0];
    if (ex) return ex.body_hash === hash ? [ex.status, ex.response] : [422, { error: 'Idempotency-Key reused with a different body' }];
    const out = await createBooking(c, body);
    await c.query('INSERT INTO idempotency(key,body_hash,status,response) VALUES($1,$2,$3,$4)', [key, hash, out[0], JSON.stringify(out[1])]);
    return out;
  });
  res.status(status).json(payload);
});

// Level 4: cursor pagination (cursor = last seq seen, base64)
app.get('/bookings', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return err(res, 400, 'email is required');
  let limit = 10;
  if (req.query.limit !== undefined) {
    if (!/^\d+$/.test(String(req.query.limit))) return err(res, 400, 'limit must be 1 to 50');
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) return err(res, 400, 'limit must be 1 to 50');
  }
  let after = 0;
  if (req.query.cursor !== undefined) {
    const d = Buffer.from(String(req.query.cursor), 'base64').toString();
    if (!/^\d+$/.test(d)) return err(res, 400, 'invalid cursor');
    after = Number(d);
  }
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE lower(email)=$1 AND seq>$2 ORDER BY seq LIMIT $3', [email, after, limit + 1]);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString('base64') : null;
  res.json({ bookings: page.map(bookingOut), next_cursor: next });
});

app.get('/bookings/:id', async (req, res) => {
  const b = (await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id])).rows[0];
  if (!b) return err(res, 404, 'booking not found');
  res.json(bookingOut(b));
});

// Level 3: cancel
app.delete('/bookings/:id', async (req, res) => {
  const out = await tx(async (c) => {
    const b = (await c.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!b) return [404, { error: 'booking not found' }];
    if (b.status === 'cancelled') return [409, { error: 'booking already cancelled' }];
    const u = await c.query(`UPDATE bookings SET status='cancelled' WHERE id=$1 RETURNING *`, [b.id]);
    return [200, bookingOut(u.rows[0])];
  });
  res.status(out[0]).json(out[1]);
});

app.use((req, res) => err(res, 404, 'not found'));
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') return err(res, 400, 'invalid JSON');
  console.error(e);
  err(res, 500, 'internal error');
});

init().then(() => app.listen(process.env.PORT || 3000, () => console.log('listening')))
  .catch((e) => { console.error(e); process.exit(1); });
