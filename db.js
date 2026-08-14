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
  ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

  CREATE INDEX IF NOT EXISTS idx_orders_queue ON orders(branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_bills_pay ON bills(payment_status, branch_id);

  -- RLS deny-all: the app connects as postgres (superuser, RLS-bypassed); these
  -- lock out the anon/authenticated roles (PostgREST) which the app never uses.
  ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
  ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE menu_item_variants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
  ALTER TABLE bill_orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE staff_accounts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
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

// Prices are in ₹ (stored as paise = ×100 at insert). Atta column = atta price; null = maida only.
const KULCHAS = [
  ['Pizza Special Kulcha', 340, null],
  ['Cheese Mushroom Corn Kulcha', 320, 340],
  ['Cheese Corn Kulcha', 300, 320],
  ['Amritsari Special Kulcha', 280, 300, 1],
  ['Cheese Chilli Garlic Kulcha', 270, 290],
  ['Cheese Paneer Kulcha', 270, 290],
  ['Hara-Bhara Cheese Kulcha', 260, 280],
  ['Mix Kulcha', 250, 270],
  ['Paneer Garlic Kulcha', 250, 270],
  ['Cheese Kulcha', 240, 260],
  ['Paneer Kulcha', 230, 250],
  ['Child Special Kulcha', 200, null],
  ['Aloo Gobi Kulcha', 170, 190],
  ['Aloo Kulcha', 160, 180],
];

const MENU = [
  ...KULCHAS.map(([name, maida, , best]) => ({ category: 'Amritsari Kulcha', name, desc: 'Served with chole & chutney.', price: maida, veg: 1, bestseller: best || 0 })),
  { category: 'Cold Drinks', name: 'Patiala Dry Fruit Lassi', desc: 'Rich lassi loaded with dry fruits.', price: 180, veg: 1, bestseller: 1 },
  { category: 'Cold Drinks', name: 'Lassi (Full)', price: 140, veg: 1 },
  { category: 'Cold Drinks', name: 'Lassi (Half)', price: 80, veg: 1 },
  { category: 'Cold Drinks', name: 'Masala Butter Milk', price: 40, veg: 1 },
  { category: 'Cold Drinks', name: 'Butter Milk', price: 30, veg: 1 },
  { category: 'Cold Drinks', name: 'Mineral Water', price: 20, veg: 1 },
  { category: 'Starters', name: 'Paneer Chilly Gravy', price: 290, veg: 1 },
  { category: 'Starters', name: 'Paneer Chilly Dry', price: 280, veg: 1 },
  { category: 'Starters', name: 'Tandoori Paneer Hilltop', price: 280, veg: 1 },
  { category: 'Starters', name: 'Cheese Chaska', price: 280, veg: 1 },
  { category: 'Starters', name: 'Tandoori Mushroom Dry', price: 280, veg: 1 },
  { category: 'Starters', name: 'Paneer Pahadi Tikka', price: 280, veg: 1 },
  { category: 'Starters', name: 'Paneer Achari Tikka Dry', price: 280, veg: 1 },
  { category: 'Starters', name: 'Paneer Tikka Dry', price: 280, veg: 1 },
  { category: 'Starters', name: 'Paneer Kali Mari Tikka Dry', price: 280, veg: 1 },
  { category: 'Starters', name: 'Paneer 65', price: 270, veg: 1 },
  { category: 'Starters', name: 'Cheese Corn Tikki', price: 270, veg: 1 },
  { category: 'Starters', name: 'Gulabi Kabab', price: 260, veg: 1 },
  { category: 'Starters', name: 'Veg. Crispy', price: 240, veg: 1 },
  { category: 'Starters', name: 'Paneer Malai Tikka Dry', price: 250, veg: 1 },
  { category: 'Starters', name: 'Hara-Bhara Kabab', price: 240, veg: 1 },
  { category: 'Soup', name: 'Cream & Veg. Soup', price: 160, veg: 1 },
  { category: 'Soup', name: 'Tomato Soup', price: 150, veg: 1 },
  { category: 'Soup', name: 'Sweet Corn Soup', price: 140, veg: 1 },
  { category: 'Soup', name: 'Hot & Sour Soup', price: 130, veg: 1 },
  { category: 'Soup', name: 'Veg. Manchow Soup', price: 120, veg: 1 },
  { category: 'Soup', name: 'Lemon Coriander Soup', price: 120, veg: 1 },
  { category: 'Salad', name: 'Mix Veg Raita', price: 120, veg: 1 },
  { category: 'Salad', name: 'Green Salad', price: 100, veg: 1 },
  { category: 'Salad', name: 'Boondi Raita', price: 100, veg: 1 },
  { category: 'Salad', name: 'Plain Curd', price: 50, veg: 1 },
  { category: 'Papad', name: 'Tuta Futa Khichiya Papad', price: 120, veg: 1 },
  { category: 'Papad', name: 'Fry Cheese Masala Papad', price: 100, veg: 1 },
  { category: 'Papad', name: 'Masala Papad', price: 50, veg: 1 },
  { category: 'Papad', name: 'Fry Papad', price: 30, veg: 1 },
  { category: 'Papad', name: 'Plain Papad', price: 20, veg: 1 },
  { category: 'Amritsari Special Thali', name: 'Punjabi Thali (Lunch)', price: 240, veg: 1, bestseller: 1 },
  { category: 'Amritsari Special Thali', name: 'Cheese Chur-Chur Naan Thali', desc: 'Chur-chur naan, dal makhani, paneer sabji, salad, chaas.', price: 330, veg: 1 },
  { category: 'Amritsari Special Thali', name: 'Cheese Paneer Chur-Chur Naan Thali', desc: 'Chur-chur naan, dal makhani, paneer sabji, salad, chaas.', price: 360, veg: 1 },
  { category: 'Amritsari Special Thali', name: 'Combo Fixed Thali (Seasonal)', price: 360, veg: 1 },
  { category: 'Amritsari Special Thali', name: 'Daal Makhani – Missi Roti Combo', price: 250, veg: 1 },
  { category: 'Amritsari Special Thali', name: 'Paneer Bhurji Tawa Paratha Combo', price: 260, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg. Badami Pasanda', price: 320, veg: 1 },
  { category: 'Veg Sabzi', name: 'Avadhi Kurma', price: 300, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Hungama', price: 280, veg: 1 },
  { category: 'Veg Sabzi', name: 'Mushroom Kaju', price: 270, veg: 1 },
  { category: 'Veg Sabzi', name: 'Saag Savera', price: 260, veg: 1 },
  { category: 'Veg Sabzi', name: 'Malai Kofta', price: 260, veg: 1 },
  { category: 'Veg Sabzi', name: 'Mushroom Masala', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Tawa', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Rajwadi', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Methi Malai Mutter', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Corn Capsicum Masala', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Kofta', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Kolhapuri', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Kadai', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Mushroom', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Mix Veg', price: 240, veg: 1 },
  { category: 'Veg Sabzi', name: 'Mutter Palak', price: 230, veg: 1 },
  { category: 'Veg Sabzi', name: 'Corn Palak', price: 230, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Handi', price: 230, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Makkhanwala', price: 230, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Hyderabadi', price: 230, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Handi Masala', price: 220, veg: 1 },
  { category: 'Veg Sabzi', name: 'Veg Jaipuri', price: 220, veg: 1 },
  { category: 'Veg Sabzi', name: 'Sarso Da Saag', price: 220, veg: 1 },
  { category: 'Veg Sabzi', name: 'Chana Masala', price: 180, veg: 1 },
  { category: 'Cheese Special', name: 'Cheese Anguri', price: 280, veg: 1 },
  { category: 'Cheese Special', name: 'Cheese Paneer Corn Masala', price: 260, veg: 1 },
  { category: 'Cheese Special', name: 'Cheese Paneer Masala', price: 250, veg: 1 },
  { category: 'Cheese Special', name: 'Cheese Handi', price: 250, veg: 1 },
  { category: 'Cheese Special', name: 'Cheese Kadai', price: 240, veg: 1 },
  { category: 'Cheese Special', name: 'Cheese Butter Masala', price: 240, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Amritsari Special', price: 300, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Tiranga', price: 300, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Hangama', price: 300, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Tiger', price: 280, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Jawala Mukhi', price: 280, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Patiyala', price: 280, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Bullet', price: 280, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Angara', price: 270, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Tawa Paneer', price: 260, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Birbal', price: 260, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Shahi Paneer', price: 260, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Kadai', price: 260, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Bhurji', price: 260, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Handi', price: 260, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Kolhapuri', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Balti', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Pasanda', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Rajwadi', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Lasaniya', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Mushroom', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer 2 Payaz', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Toofani', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Chatpatta', price: 250, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Tikka Masala', price: 240, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Lakhnavi', price: 230, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Palak Paneer', price: 230, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Chana Paneer', price: 230, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer La Jawab', price: 230, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Mutter Paneer', price: 230, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Capsicum', price: 230, veg: 1 },
  { category: 'Paneer Sabzi', name: 'Paneer Butter Masala', price: 220, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Paneer Cheese Masala', price: 300, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Khoya', price: 280, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Paneer Masala', price: 280, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Handi', price: 270, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Masala', price: 270, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Curry', price: 260, veg: 1 },
  { category: 'Kaju Sabzi', name: 'Kaju Cheese Masala', price: 250, veg: 1 },
  { category: 'Tandoor Se', name: 'Roti Basket', price: 370, veg: 1 },
  { category: 'Tandoor Se', name: 'Cheese Chilli Garlic Naan', price: 170, veg: 1 },
  { category: 'Tandoor Se', name: 'Cheese Chilli Naan', price: 160, veg: 1 },
  { category: 'Tandoor Se', name: 'Cheese Naan', price: 150, veg: 1, bestseller: 1 },
  { category: 'Tandoor Se', name: 'ChurChur Naan', price: 140, veg: 1 },
  { category: 'Tandoor Se', name: 'Garlic Naan', price: 110, veg: 1 },
  { category: 'Tandoor Se', name: 'Butter Naan', price: 100, veg: 1 },
  { category: 'Tandoor Se', name: 'Plain Naan', price: 80, veg: 1 },
  { category: 'Tandoor Se', name: 'Lachha Paratha', price: 80, veg: 1 },
  { category: 'Tandoor Se', name: 'Makai Roti', price: 60, veg: 1 },
  { category: 'Tandoor Se', name: 'Missi Roti', price: 60, veg: 1 },
  { category: 'Tandoor Se', name: 'Bajra Roti', price: 60, veg: 1 },
  { category: 'Tandoor Se', name: 'Tandoori Roti – Butter', price: 40, veg: 1 },
  { category: 'Tandoor Se', name: 'Tandoori Roti – Plain', price: 30, veg: 1 },
  { category: 'Tandoor Se', name: 'Tawa Roti – Butter', price: 30, veg: 1 },
  { category: 'Tandoor Se', name: 'Tawa Roti – Plain', price: 25, veg: 1 },
  { category: 'Dal', name: 'Dal Makhani Tadka', price: 220, veg: 1 },
  { category: 'Dal', name: 'Dal Makhani', desc: 'Slow-cooked black lentils in butter and cream.', price: 210, veg: 1, bestseller: 1 },
  { category: 'Dal', name: 'Dal Tadka', price: 200, veg: 1 },
  { category: 'Dal', name: 'Dal Palak', price: 200, veg: 1 },
  { category: 'Dal', name: 'Dal Fry', price: 150, veg: 1 },
  { category: 'Rice', name: 'Matka Cheese Special Biryani', price: 280, veg: 1 },
  { category: 'Rice', name: 'Kaju Pulav', price: 240, veg: 1 },
  { category: 'Rice', name: 'Handi Biryani', price: 230, veg: 1 },
  { category: 'Rice', name: 'Veg Hyderabadi Biryani', price: 230, veg: 1 },
  { category: 'Rice', name: 'Paneer Pulav', price: 230, veg: 1 },
  { category: 'Rice', name: 'Veg Biryani', price: 220, veg: 1 },
  { category: 'Rice', name: 'Veg Pulav', price: 190, veg: 1 },
  { category: 'Rice', name: 'Jeera Rice', price: 140, veg: 1 },
  { category: 'Rice', name: 'Steam Rice', price: 120, veg: 1 },
];

const VARIANTS = {};
for (const [name, maida, atta] of KULCHAS) {
  VARIANTS[name] = [
    { v: 'Maida', d: 0 },
    ...(atta ? [{ v: 'Atta', d: atta - maida }] : []),
    { v: 'Extra Butter', d: 10 },
  ];
}

for (const m of MENU) {
  if (m.bestseller === undefined) m.bestseller = 0;
  if (m.desc === undefined) m.desc = '';
}

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
    await syncMenu();
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
      await client.query('INSERT INTO menu_items (id,category,name,description,base_price,is_veg,bestseller) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, m.category, m.name, m.desc, m.price * 100, m.veg, m.bestseller]);
      for (const v of (VARIANTS[m.name] || [])) await client.query('INSERT INTO menu_item_variants (id,menu_item_id,variant_name,price_delta) VALUES ($1,$2,$3,$4)', [uid('var'), id, v.v, v.d * 100]);
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

// Keep the live menu in step with MENU/VARIANTS: insert new items, update prices,
// hide removed items (history preserved via orders). No-op when nothing changed.
async function syncMenu() {
  const existing = await db.prepare('SELECT id, name FROM menu_items').all();
  const names = new Set(existing.map(e => e.name));
  const need = MENU.map(m => m.name);
  const needSet = new Set(need);
  const unchanged = need.every(n => names.has(n)) && existing.every(e => needSet.has(e.name));
  if (unchanged) return;

  await tx(async (client) => {
    const byName = new Map(existing.map(e => [e.name, e.id]));
    for (const m of MENU) {
      const id = byName.get(m.name);
      if (id) {
        await q(client, 'UPDATE menu_items SET category=?, description=?, base_price=?, is_veg=?, bestseller=? WHERE id=?',
          m.category, m.desc, m.price * 100, m.veg, m.bestseller, id);
      } else {
        const nid = uid('mi');
        await q(client, 'INSERT INTO menu_items (id,category,name,description,base_price,is_veg,bestseller,available) VALUES (?,?,?,?,?,?,?,1)',
          nid, m.category, m.name, m.desc, m.price * 100, m.veg, m.bestseller);
        byName.set(m.name, nid);
        existing.push({ id: nid, name: m.name });
      }
      const itemId = byName.get(m.name);
      await q(client, 'DELETE FROM menu_item_variants WHERE menu_item_id=?', itemId);
      for (const v of (VARIANTS[m.name] || [])) {
        await q(client, 'INSERT INTO menu_item_variants (id,menu_item_id,variant_name,price_delta) VALUES (?,?,?,?)', uid('var'), itemId, v.v, v.d * 100);
      }
    }
    for (const e of existing) {
      if (!needSet.has(e.name)) await q(client, 'UPDATE menu_items SET available=0 WHERE id=?', e.id);
    }
  });
}
