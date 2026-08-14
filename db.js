import pg from 'pg';
import { scryptSync, randomBytes } from 'node:crypto';

// Postgres everywhere (Vercel serverless + local dev). Set DATABASE_URL.
// Local: create a .env with DATABASE_URL=... or export it in the shell.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
});

// Keep timestamps as the raw 'YYYY-MM-DD HH24:MI:SS.ffffff' string (SQLite-compatible),
// so frontends and the undo window keep working: new Date('...') + 'Z'.
pg.types.setTypeParser(1114, (v) => v); // TIMESTAMP
pg.types.setTypeParser(1184, (v) => v); // TIMESTAMPTZ
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

// Tiny `?` -> $n mapper so SQL reads like the old SQLite layer.
function convert(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export const db = {
  exec: (sql) => pool.query(sql),
  prepare(sql) {
    const text = convert(sql);
    return {
      all: async (...args) => (await pool.query(text, args)).rows,
      get: async (...args) => (await pool.query(text, args)).rows[0],
      run: async (...args) => { await pool.query(text, args); },
    };
  },
};

// Transaction runner on a dedicated client (pool.query is not transactional).
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export const q = (client, sql, ...args) => client.query(convert(sql), args);

export const DEFAULT_TAX_RATE = 5; // % GST
export const DEFAULT_SERVICE_CHARGE = 1500; // paise (₹15)

export async function getSetting(key, def) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
export async function setSetting(key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value').run(key, value);
}
export const getTaxRate = async () => Number(await getSetting('tax_rate', DEFAULT_TAX_RATE));
export const getServiceCharge = async () => Number(await getSetting('service_charge', DEFAULT_SERVICE_CHARGE));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    whatsapp_number TEXT,
    address TEXT,
    gstin TEXT,
    review_link TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
  );

  CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id),
    table_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    locked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(branch_id, table_number)
  );
  ALTER TABLE tables ADD COLUMN IF NOT EXISTS token TEXT;

  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    base_price INTEGER NOT NULL,
    is_veg INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 1,
    bestseller INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS menu_item_variants (
    id TEXT PRIMARY KEY,
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    variant_name TEXT NOT NULL,
    price_delta INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id),
    table_id TEXT NOT NULL REFERENCES tables(id),
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    variant_id TEXT REFERENCES menu_item_variants(id),
    quantity INTEGER NOT NULL,
    price_at_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    branch_id TEXT NOT NULL REFERENCES branches(id),
    subtotal INTEGER NOT NULL,
    tax_amount INTEGER NOT NULL,
    tax_rate_snapshot REAL NOT NULL,
    service_charge INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT,
    customer_phone TEXT,
    paid_at TIMESTAMP,
    notif_failed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
  );

  CREATE TABLE IF NOT EXISTS bill_orders (
    bill_id TEXT NOT NULL REFERENCES bills(id),
    order_id TEXT NOT NULL REFERENCES orders(id),
    PRIMARY KEY (bill_id, order_id)
  );

  CREATE TABLE IF NOT EXISTS staff_accounts (
    id TEXT PRIMARY KEY,
    branch_id TEXT REFERENCES branches(id),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('kitchen','reception','admin')),
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id TEXT PRIMARY KEY,
    bill_id TEXT NOT NULL REFERENCES bills(id),
    type TEXT NOT NULL CHECK (type IN ('invoice','review_request')),
    phone TEXT,
    sent_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
    status TEXT NOT NULL DEFAULT 'sent'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff_accounts(id),
    exp BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    lock_until BIGINT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_queue ON orders(branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_bills_pay ON bills(payment_status, branch_id);
`;

export function uid(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = scryptSync(password, salt, 64).toString('hex');
  return test === hash;
}

const BRANCHES = [
  { id: 'alkapuri', name: 'Alkapuri', whatsapp: '919898989898', address: 'Alkapuri, Vadodara', gstin: '24AABCK0001A1Z5', review: 'https://g.page/r/ALKAPURI/review' },
  { id: 'nizampura', name: 'Nizampura', whatsapp: '919898989899', address: 'Nizampura, Vadodara', gstin: '24AABCK0001A1Z5', review: 'https://g.page/r/NIZAMPURA/review' },
  { id: 'old-chhani-road', name: 'Old Chhani Road', whatsapp: '919898989800', address: 'Old Chhani Road, Vadodara', gstin: '24AABCK0001A1Z5', review: 'https://g.page/r/CHHANI/review' },
  { id: 'gorwa', name: 'Gorwa', whatsapp: '919898989801', address: 'Gorwa, Vadodara', gstin: '24AABCK0001A1Z5', review: 'https://g.page/r/GORWA/review' },
];

const MENU = [
  { category: 'Signature Kulchas', name: 'Amritsari Paneer Kulcha', desc: 'Crispy tandoori bread stuffed with spiced paneer, onions and fresh coriander, served with chole & chutney.', price: 24000, veg: 1, bestseller: 1 },
  { category: 'Signature Kulchas', name: 'Classic Aloo Kulcha', desc: 'The original Amritsari special. Mashed potatoes with crushed coriander seeds and anardana.', price: 18000, veg: 1, bestseller: 0 },
  { category: 'Thali', name: 'Chur Chur Naan Thali', desc: 'Crispy, flaky crushed naan served with unlimited dal makhani, chole and raita.', price: 32000, veg: 1, bestseller: 1 },
  { category: 'Accompaniments', name: 'Extra White Makhan', desc: 'A generous slab of house churned white butter.', price: 4000, veg: 1, bestseller: 0 },
  { category: 'Accompaniments', name: 'Boondi Raita', desc: 'Cooling boondi raita with roasted cumin and chilli.', price: 8000, veg: 1, bestseller: 0 },
  { category: 'Beverages', name: 'Classic Sweet Lassi', desc: 'Served chilled in a kulhad.', price: 9000, veg: 1, bestseller: 0 },
  { category: 'Beverages', name: 'Masala Chaas', desc: 'Spiced buttermilk with mint and ginger.', price: 6000, veg: 1, bestseller: 0 },
  { category: 'Sweets', name: 'Gajar Halwa', desc: 'Slow-cooked carrot halwa with ghee and khoya.', price: 14000, veg: 1, bestseller: 0 },
  { category: 'Sweets', name: 'Rasmalai', desc: 'Soft chhena discs in saffron-sweetened milk.', price: 16000, veg: 1, bestseller: 0 },
];

const VARIANTS = {
  'Amritsari Paneer Kulcha': [{ v: 'Maida', d: 0 }, { v: 'Atta', d: 500 }, { v: 'Extra Butter', d: 2000 }],
  'Classic Aloo Kulcha': [{ v: 'Maida', d: 0 }, { v: 'Atta', d: 500 }],
};

const STAFF = [
  { branch: 'alkapuri', user: 'kitchen_alkapuri', pass: 'kitchen123', role: 'kitchen' },
  { branch: 'alkapuri', user: 'reception_alkapuri', pass: 'reception123', role: 'reception' },
  { branch: 'nizampura', user: 'kitchen_nizampura', pass: 'kitchen123', role: 'kitchen' },
  { branch: 'nizampura', user: 'reception_nizampura', pass: 'reception123', role: 'reception' },
  { branch: 'old-chhani-road', user: 'kitchen_oldchhani', pass: 'kitchen123', role: 'kitchen' },
  { branch: 'old-chhani-road', user: 'reception_oldchhani', pass: 'reception123', role: 'reception' },
  { branch: 'gorwa', user: 'kitchen_gorwa', pass: 'kitchen123', role: 'kitchen' },
  { branch: 'gorwa', user: 'reception_gorwa', pass: 'reception123', role: 'reception' },
  { branch: null, user: 'owner', pass: 'owner123', role: 'admin' },
];

export async function seed() {
  await db.exec(SCHEMA);
  const rows = (await pool.query('SELECT COUNT(*) AS n FROM branches')).rows;
  if (Number(rows[0].n) > 0) {
    await backfillTokens();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const b of BRANCHES) {
      await client.query('INSERT INTO branches (id,name,whatsapp_number,address,gstin,review_link) VALUES ($1,$2,$3,$4,$5,$6)', [b.id, b.name, b.whatsapp, b.address, b.gstin, b.review]);
      for (let t = 1; t <= 12; t++) await client.query('INSERT INTO tables (id,branch_id,table_number) VALUES ($1,$2,$3)', [uid('tbl'), b.id, t]);
    }
    for (const m of MENU) {
      const id = uid('mi');
      await client.query('INSERT INTO menu_items (id,category,name,description,base_price,is_veg,bestseller) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, m.category, m.name, m.desc, m.price, m.veg, m.bestseller]);
      for (const v of (VARIANTS[m.name] || [])) await client.query('INSERT INTO menu_item_variants (id,menu_item_id,variant_name,price_delta) VALUES ($1,$2,$3,$4)', [uid('var'), id, v.v, v.d]);
    }
    for (const s of STAFF) {
      await client.query('INSERT INTO staff_accounts (id,branch_id,username,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [uid('stf'), s.branch, s.user, hashPassword(s.pass), s.role]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await backfillTokens();
}

async function backfillTokens() {
  const missing = await db.prepare("SELECT id FROM tables WHERE token IS NULL OR token = ''").all();
  for (const t of missing) {
    await db.prepare('UPDATE tables SET token = ? WHERE id = ?').run(randomBytes(6).toString('hex'), t.id);
  }
}
