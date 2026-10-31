// Fills the clinic with clean demo slots (all available). WARNING: wipes all bookings.
// Usage: BASE_URL=https://your-app.onrender.com API_KEY=secret node seed.js
const BASE = (process.env.BASE_URL || '').replace(/\/$/, ''), KEY = process.env.API_KEY;
if (!BASE || !KEY) { console.error('Set BASE_URL and API_KEY'); process.exit(1); }
const DOCS = ['Dr Ade', 'Dr Tony', 'Dr Okeke', 'Dr Afam'];
const slots = [];
for (let day = 1; day <= 3; day++) {
  for (let i = 0; i < 8; i++) {            // 9:00-16:00 UTC, hourly start, 30 min each
    const start = new Date(); start.setUTCDate(start.getUTCDate() + day); start.setUTCHours(9 + i, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60000);
    slots.push({ id: `d${day}-${i + 1}`, provider: DOCS[(slots.length) % 4], start: start.toISOString(), end: end.toISOString() });
  }
}
fetch(BASE + '/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify({ slots }) })
  .then(async (r) => console.log(r.status, await r.text()));
