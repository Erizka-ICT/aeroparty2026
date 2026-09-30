import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';
import QRCode from 'qrcode';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const appName = process.env.APP_NAME || 'AeroParty 2026';
const stepPrice = Number(process.env.STEP_PRICE_IDR || 150000);
const paymentExpiryMinutes = Number(process.env.PAYMENT_EXPIRY_MINUTES || 60);
const isProduction = String(process.env.MIDTRANS_ENV || 'sandbox').toLowerCase() === 'production';
const midtransApi = isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set. Create .env before starting the server.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const money = n => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(n));
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const basicAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate', 'Basic realm="AeroParty Admin"').json({ error: 'Admin login required.' });
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  if (!safeEqual(user, process.env.ADMIN_USERNAME || 'admin') || !safeEqual(pass, process.env.ADMIN_PASSWORD || 'change-this-password')) {
    return res.status(401).set('WWW-Authenticate', 'Basic realm="AeroParty Admin"').json({ error: 'Invalid credentials.' });
  }
  next();
};

async function initDb() {
  const { readFile } = await import('fs/promises');
  const sql = await readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function midtransCharge({ orderId, amount, bank, name, email, phone }) {
  if (!process.env.MIDTRANS_SERVER_KEY || process.env.MIDTRANS_SERVER_KEY.includes('xxxxxxxx')) {
    throw new Error('Midtrans Server Key belum diisi. Website bisa dites tanpa pembayaran, tetapi untuk VA nyata isi MIDTRANS_SERVER_KEY.');
  }
  const auth = Buffer.from(`${process.env.MIDTRANS_SERVER_KEY}:`).toString('base64');
  const body = {
    payment_type: 'bank_transfer',
    bank_transfer: { bank },
    transaction_details: { order_id: orderId, gross_amount: amount },
    customer_details: { first_name: name, email, phone },
    item_details: [{ id: `STEP-${orderId}`, price: amount, quantity: 1, name: `${appName} - Step Position` }],
    custom_expiry: { expiry_duration: paymentExpiryMinutes, unit: 'minute' }
  };
  const response = await fetch(`${midtransApi}/v2/charge`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.status_message || 'Midtrans gagal membuat Virtual Account.');
  return data;
}

function extractVa(data) {
  if (Array.isArray(data.va_numbers) && data.va_numbers[0]) {
    return { bank: data.va_numbers[0].bank, va: data.va_numbers[0].va_number };
  }
  if (data.permata_va?.va_number) return { bank: 'permata', va: data.permata_va.va_number };
  if (data.bca_va?.va_number) return { bank: 'bca', va: data.bca_va.va_number };
  if (data.bni_va?.va_number) return { bank: 'bni', va: data.bni_va.va_number };
  if (data.bri_va?.va_number) return { bank: 'bri', va: data.bri_va.va_number };
  return { bank: null, va: null };
}

app.get('/api/config', (req, res) => res.json({ appName, stepPrice, classes: ['pemula', 'middle', 'aerobik'] }));

app.get('/api/classes', async (req, res) => {
  const { rows } = await pool.query(`SELECT c.id,c.name,c.slug,c.description, COUNT(s.id)::int AS total,
    COUNT(*) FILTER (WHERE s.status='available')::int AS available,
    COUNT(*) FILTER (WHERE s.status='pending')::int AS pending,
    COUNT(*) FILTER (WHERE s.status='paid')::int AS paid
    FROM classes c LEFT JOIN steps s ON s.class_id=c.id GROUP BY c.id ORDER BY c.id`);
  res.json(rows);
});

app.get('/api/classes/:slug/steps', async (req, res) => {
  const { rows } = await pool.query(`SELECT s.step_number,s.status FROM steps s JOIN classes c ON c.id=s.class_id WHERE c.slug=$1 ORDER BY s.step_number`, [req.params.slug]);
  if (!rows.length) return res.status(404).json({ error: 'Class not found.' });
  res.json({ classSlug: req.params.slug, steps: rows });
});

app.post('/api/bookings', async (req, res) => {
  const { classSlug, stepNumber, fullName, phone, email, bank } = req.body || {};
  const allowedBanks = new Set(['bca', 'bni', 'bri', 'permata']);
  if (!classSlug || !Number.isInteger(Number(stepNumber)) || Number(stepNumber) < 1 || Number(stepNumber) > 50 || !fullName?.trim() || !phone?.trim() || !email?.trim() || !allowedBanks.has(bank)) {
    return res.status(400).json({ error: 'Data belum lengkap atau tidak valid.' });
  }
  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    const classResult = await client.query('SELECT id,name FROM classes WHERE slug=$1', [classSlug]);
    if (!classResult.rows[0]) throw new Error('Kelas tidak ditemukan.');
    const cls = classResult.rows[0];
    const stepResult = await client.query(`SELECT id,status FROM steps WHERE class_id=$1 AND step_number=$2 FOR UPDATE`, [cls.id, Number(stepNumber)]);
    if (!stepResult.rows[0]) throw new Error('Nomor step tidak ditemukan.');
    if (stepResult.rows[0].status !== 'available') throw new Error('Nomor step tersebut sudah sedang diproses atau sudah terjual. Silakan pilih nomor lain.');
    const orderId = `AP26-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`.slice(0, 50);
    const insert = await client.query(`INSERT INTO bookings(order_id,class_id,step_id,full_name,phone,email,amount,status,payment_expiry)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',NOW()+($8 * INTERVAL '1 minute')) RETURNING *`,
      [orderId, cls.id, stepResult.rows[0].id, fullName.trim(), phone.trim(), email.trim().toLowerCase(), stepPrice, paymentExpiryMinutes]);
    await client.query(`UPDATE steps SET status='pending' WHERE id=$1`, [stepResult.rows[0].id]);
    await client.query('COMMIT');
    booking = { ...insert.rows[0], class_name: cls.name, step_number: Number(stepNumber) };
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(409).json({ error: err.message });
  } finally { client.release(); }

  try {
    const payment = await midtransCharge({ orderId: booking.order_id, amount: booking.amount, bank, name: booking.full_name, email: booking.email, phone: booking.phone });
    const vaInfo = extractVa(payment);
    if (!vaInfo.va) throw new Error('Midtrans berhasil membuat transaksi tetapi nomor Virtual Account tidak diterima.');
    const expiry = payment.expiry_time ? new Date(payment.expiry_time) : new Date(Date.now() + paymentExpiryMinutes * 60000);
    await pool.query(`UPDATE bookings SET bank=$1,va_number=$2,midtrans_transaction_id=$3,payment_expiry=$4 WHERE id=$5`, [vaInfo.bank || bank, vaInfo.va, payment.transaction_id || null, expiry, booking.id]);
    return res.json({ orderId: booking.order_id, className: booking.class_name, stepNumber: booking.step_number, amount: booking.amount, bank: vaInfo.bank || bank, vaNumber: vaInfo.va, paymentExpiry: expiry.toISOString(), status: 'pending' });
  } catch (err) {
    await pool.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [booking.id]);
    await pool.query(`UPDATE steps SET status='available' WHERE id=$1`, [booking.step_id]);
    return res.status(502).json({ error: err.message });
  }
});

app.get('/api/bookings/:orderId', async (req, res) => {
  const { rows } = await pool.query(`SELECT b.order_id,b.full_name,b.phone,b.email,b.amount,b.status,b.bank,b.va_number,b.payment_expiry,b.created_at,b.paid_at,c.name AS class_name,s.step_number
    FROM bookings b JOIN classes c ON c.id=b.class_id JOIN steps s ON s.id=b.step_id WHERE b.order_id=$1`, [req.params.orderId]);
  if (!rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan.' });
  res.json(rows[0]);
});

app.post('/api/midtrans/notification', async (req, res) => {
  const n = req.body || {};
  const expected = crypto.createHash('sha512').update(`${n.order_id}${n.status_code}${n.gross_amount}${process.env.MIDTRANS_SERVER_KEY || ''}`).digest('hex');
  if (!safeEqual(expected, n.signature_key)) return res.status(403).json({ error: 'Invalid signature.' });
  const bookingResult = await pool.query('SELECT * FROM bookings WHERE order_id=$1', [n.order_id]);
  if (!bookingResult.rows[0]) return res.json({ ok: true });
  const booking = bookingResult.rows[0];
  const status = String(n.transaction_status || '').toLowerCase();
  if ((status === 'settlement' || (status === 'capture' && String(n.fraud_status || '').toLowerCase() === 'accept')) && booking.status !== 'paid') {
    await pool.query('BEGIN');
    try {
      await pool.query(`UPDATE bookings SET status='paid',paid_at=NOW(),midtrans_transaction_id=COALESCE($1,midtrans_transaction_id) WHERE id=$2`, [n.transaction_id || null, booking.id]);
      await pool.query(`UPDATE steps SET status='paid' WHERE id=$1`, [booking.step_id]);
      await pool.query('COMMIT');
    } catch (e) { await pool.query('ROLLBACK'); throw e; }
  } else if (status === 'expire' || status === 'cancel' || status === 'deny') {
    await pool.query(`UPDATE bookings SET status=$1 WHERE id=$2 AND status='pending'`, [status === 'expire' ? 'expired' : 'cancelled', booking.id]);
    await pool.query(`UPDATE steps SET status='available' WHERE id=$1 AND status='pending'`, [booking.step_id]);
  }
  res.json({ ok: true });
});

app.get('/api/admin/bookings', basicAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT b.order_id,b.full_name,b.phone,b.email,b.amount,b.status,b.bank,b.va_number,b.payment_expiry,b.created_at,b.paid_at,c.name AS class_name,s.step_number
    FROM bookings b JOIN classes c ON c.id=b.class_id JOIN steps s ON s.id=b.step_id ORDER BY b.created_at DESC LIMIT 500`);
  res.json(rows);
});

app.get('/api/admin/stats', basicAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*) FROM bookings)::int AS bookings,
    (SELECT COUNT(*) FROM bookings WHERE status='paid')::int AS paid,
    (SELECT COUNT(*) FROM bookings WHERE status='pending')::int AS pending,
    (SELECT COUNT(*) FROM steps WHERE status='available')::int AS available,
    (SELECT COALESCE(SUM(amount),0) FROM bookings WHERE status='paid')::int AS revenue`);
  res.json(rows[0]);
});

app.post('/api/admin/reset-expired', basicAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE bookings SET status='expired' WHERE status='pending' AND payment_expiry < NOW() RETURNING step_id`);
    for (const row of result.rows) await client.query(`UPDATE steps SET status='available' WHERE id=$1 AND status='pending'`, [row.step_id]);
    await client.query('COMMIT');
    res.json({ released: result.rowCount });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(port, () => console.log(`${appName} running on port ${port}`));
}).catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
