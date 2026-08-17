import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { db, tx, q, seed, uid, verifyPassword, getTaxRate, getServiceCharge, setSetting } from '../db.js';
import { sendTemplate } from '../wa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000;

await seed();

// ---------- Sessions (DB-backed — survives serverless cold starts) ----------
const cookieFlags = (req) => {
  const secure = !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
};

async function createSession(staff, req, res) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, staff_id, exp) VALUES (?,?,?)').run(token, staff.id, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_TTL / 1000}`);
}

async function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('sid='));
  if (!cookie) return null;
  const token = cookie.slice(4);
  const s = await db.prepare(`
    SELECT s.token, s.staff_id, s.exp, st.username, st.role, st.branch_id
    FROM sessions s JOIN staff_accounts st ON st.id = s.staff_id
    WHERE s.token = ? AND st.active = 1
  `).get(token);
  if (!s) return null;
  if (Date.now() > Number(s.exp)) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { token, staffId: s.staff_id, username: s.username, role: s.role, branchId: s.branch_id, exp: Number(s.exp) };
}

// ---------- Order rate limiting (per table — a valid QR token must not allow spam) ----------
// ponytail: in-memory, per-process; fine on the single Render instance, move to DB if multi-instance.
const ORDER_RATE_MAX = 10;
const ORDER_RATE_WINDOW = 60 * 1000;
const orderRate = new Map();
function orderRateLimited(tableId) {
  const now = Date.now();
  const recent = (orderRate.get(tableId) || []).filter(t => now - t < ORDER_RATE_WINDOW);
  if (recent.length >= ORDER_RATE_MAX) return true;
  recent.push(now);
  orderRate.set(tableId, recent);
  return false;
}

// ---------- Login rate limiting (DB-backed) ----------
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

async function checkRateLimit(ip) {
  const r = await db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
  if (!r) return { allowed: true };
  if (r.lock_until && Date.now() < Number(r.lock_until)) {
    return { allowed: false, retryAfter: Math.ceil((Number(r.lock_until) - Date.now()) / 1000) };
  }
  return { allowed: true };
}
async function recordFailure(ip) {
  await db.prepare("INSERT INTO login_attempts (ip, count, updated_at) VALUES (?,1,(now() AT TIME ZONE 'UTC')) ON CONFLICT (ip) DO UPDATE SET count = login_attempts.count + 1, updated_at = (now() AT TIME ZONE 'UTC')").run(ip);
  const r = await db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
  if (r.count >= MAX_ATTEMPTS) {
    await db.prepare("UPDATE login_attempts SET lock_until = ?, count = 0, updated_at = (now() AT TIME ZONE 'UTC') WHERE ip = ?").run(Date.now() + LOCK_MS, ip);
  }
}

// ---------- Helpers ----------
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const ok = (res, data) => send(res, 200, { success: true, data });
const err = (res, code, message, status = 400) => send(res, status, { success: false, error: { code, message } });

const staffSession = async (req, res) => {
  const s = await getSession(req);
  if (!s) { err(res, 'UNAUTHENTICATED', 'Please log in', 401); return null; }
  return s;
};
const branchScope = (s, branchId) => {
  if (s.role === 'admin') return true;
  if (!branchId || s.branchId !== branchId) return false;
  return true;
};
const checkOrigin = (req, res) => {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = new URL(`http://${req.headers.host}`).hostname;
    if (o.hostname !== host) { err(res, 'CSRF', 'Forbidden', 403); return false; }
  } catch { err(res, 'CSRF', 'Forbidden', 403); return false; }
  return true;
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

async function getTableWithBranch(branchSlug, tableNumber) {
  return db.prepare(`
    SELECT t.*, b.id AS branch_slug, b.name AS branch_name FROM tables t
    JOIN branches b ON b.id = t.branch_id
    WHERE b.id = ? AND t.table_number = ?
  `).get(branchSlug, tableNumber);
}

async function orderWithItems(orderId) {
  const order = await db.prepare('SELECT o.*, t.table_number FROM orders o JOIN tables t ON t.id = o.table_id WHERE o.id = ?').get(orderId);
  if (!order) return null;
  order.items = await db.prepare(`
    SELECT oi.*, mi.name AS item_name, mi.is_veg, mv.variant_name
    FROM order_items oi
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
    WHERE oi.order_id = ?
  `).all(orderId);
  return order;
}

const NEXT_STATUS = { new: 'preparing', preparing: 'ready', ready: 'delivered' };
const PREV_STATUS = { preparing: 'new', ready: 'preparing', delivered: 'ready' };

// ---------- Notifications (WhatsApp Cloud API) ----------
async function notifyInvoice(bill) {
  if (!bill.customer_phone) return;
  const log = (status) => db.prepare('INSERT INTO notification_log (id, bill_id, type, phone, status) VALUES (?,?,?,?,?)').run(uid('ntf'), bill.id, 'invoice', bill.customer_phone, status);
  const tpl = process.env.WA_TPL_BILL || 'bill_receipt';
  const params = [bill.branch_name, `Table ${bill.table_number}`, `₹${(bill.total / 100).toFixed(2)}`];
  const res = await sendTemplate(bill.customer_phone, tpl, params);
  await log(res.status);
  if (res.status === 'failed') {
    const retry = await sendTemplate(bill.customer_phone, tpl, params);
    await log(retry.status);
    if (retry.status === 'failed') await db.prepare('UPDATE bills SET notif_failed = 1 WHERE id = ?').run(bill.id);
  }
  console.log(`[notify] invoice for bill ${bill.id} -> ${bill.customer_phone} (${res.status})`);
}

// Review request: once per phone + date, ~24h after payment.
// No background process on Render free — runs lazily on staff page polls.
let lastSweep = 0;
async function sweepStale() {
  const now = Date.now();
  if (now - lastSweep < 3600e3) return;
  lastSweep = now;
  await db.prepare('DELETE FROM sessions WHERE exp < ?').run(now);
  await db.prepare("DELETE FROM login_attempts WHERE updated_at IS NULL OR updated_at < (now() AT TIME ZONE 'UTC') - interval '24 hours'").run();
}
async function reviewJob() {
  await sweepStale();
  const due = await db.prepare(`
    SELECT b.id, b.customer_phone, br.name AS branch_name, br.review_link,
      substr(b.paid_at::text,1,10) AS paid_date FROM bills b
    JOIN branches br ON br.id = b.branch_id
    WHERE b.payment_status = 'paid' AND b.customer_phone IS NOT NULL
      AND b.paid_at <= ((now() AT TIME ZONE 'UTC') - interval '24 hours')
      AND NOT EXISTS (
        SELECT 1 FROM notification_log n
        WHERE n.bill_id = b.id AND n.type = 'review_request'
      )
      AND NOT EXISTS (
        SELECT 1 FROM notification_log n2
        WHERE n2.type = 'review_request' AND n2.phone = b.customer_phone
          AND substr(n2.sent_at::text,1,10) = to_char((now() AT TIME ZONE 'UTC'),'YYYY-MM-DD')
      )
  `).all();
  for (const r of due) {
    const res = await sendTemplate(r.customer_phone, process.env.WA_TPL_REVIEW || 'review_request', [r.branch_name, r.review_link]);
    await db.prepare("INSERT INTO notification_log (id, bill_id, type, phone, status) VALUES (?,?,?,?,?)").run(uid('ntf'), r.id, 'review_request', r.customer_phone, res.status);
    console.log(`[notify] review request bill ${r.id} -> ${r.customer_phone} (paid ${r.paid_date}, ${res.status})`);
  }
}

async function getBill(billId) {
  const bill = await db.prepare(`
    SELECT b.*, t.table_number, br.name AS branch_name
    FROM bills b JOIN tables t ON t.id = b.table_id JOIN branches br ON br.id = b.branch_id
    WHERE b.id = ?
  `).get(billId);
  if (!bill) return null;
  bill.orders = await db.prepare(`
    SELECT o.id, o.status, o.created_at,
      string_agg((oi.quantity::text || 'x ' || COALESCE(mi.name, 'unknown') || CASE WHEN mv.variant_name IS NOT NULL THEN ' (' || mv.variant_name || ')' ELSE '' END), ', ') AS summary
    FROM bill_orders bo
    JOIN orders o ON o.id = bo.order_id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
    WHERE bo.bill_id = ?
    GROUP BY o.id
  `).all(billId);
  bill.lines = await db.prepare(`
    SELECT mi.name, oi.quantity, oi.price_at_order
    FROM bill_orders bo
    JOIN orders o ON o.id = bo.order_id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE bo.bill_id = ?
  `).all(billId);
  return bill;
}

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// ---------- Router (used by Vercel and by server.js for local dev) ----------
export default async function handler(req, res) {
  try {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;
  const method = req.method;

  // ---- Static assets ----
  if (pathname.startsWith('/assets/')) {
    const file = path.join(PUBLIC_DIR, pathname);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { err(res, 'NOT_FOUND', 'Not found', 404); return; }
    const ext = path.extname(file);
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(file));
    return;
  }

  // ---- Pages ----
  if (method === 'GET' && pathname === '/') {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }
  const pageMatch = pathname.match(/^\/b\/([\w-]+)\/(\d+)$/);
  if (method === 'GET' && pageMatch) {
    const t = await getTableWithBranch(pageMatch[1], Number(pageMatch[2]));
    if (!t || t.token !== searchParams.get('t')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'invalid-qr.html'))); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'order.html')));
    return;
  }
  if (method === 'GET' && ['/login', '/kitchen', '/reception', '/admin', '/tables-qr', '/dashboard', '/track'].includes(pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(PUBLIC_DIR, pathname.slice(1) + '.html')));
    return;
  }

  // ---- API ----
  if (!pathname.startsWith('/api/')) { err(res, 'NOT_FOUND', 'Not found', 404); return; }

  if (method === 'GET' && pathname === '/api/health') {
    return ok(res, { status: 'ok' });
  }

  // Public: catalog
  if (method === 'GET' && pathname === '/api/catalog/menu') {
    const branch = searchParams.get('branch');
    if (!branch) return err(res, 'BAD_REQUEST', 'branch required');
    const items = await db.prepare('SELECT id, category, name, description, base_price, is_veg, available, bestseller FROM menu_items WHERE available = 1 ORDER BY category, name').all();
    const variants = await db.prepare('SELECT * FROM menu_item_variants').all();
    return ok(res, {
      branch,
      categories: [...new Set(items.map(i => i.category))],
      items: items.map(i => ({ ...i, variants: variants.filter(v => v.menu_item_id === i.id).map(v => ({ id: v.id, name: v.variant_name, priceDelta: v.price_delta })) })),
    });
  }

  // Public: create order (token from QR required — prevents ordering from anywhere)
  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    const t = await getTableWithBranch(String(body.branch || ''), Number(body.tableNumber));
    if (!t || t.token !== String(body.token || '')) return err(res, 'BAD_TABLE', 'This QR code is not valid. Please ask staff for help.');
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM bills WHERE table_id = ? AND payment_status = 'pending'").get(t.id);
    if (t.locked || Number(pending.n) > 0) {
      return err(res, 'TABLE_LOCKED', 'This table is currently being billed. Please ask staff.');
    }
    if (orderRateLimited(t.id)) return err(res, 'RATE_LIMITED', 'Too many orders from this table. Please wait a minute.', 429);
    if (!Array.isArray(body.items) || body.items.length === 0) return err(res, 'BAD_REQUEST', 'No items in order');
    if (body.items.length > 100) return err(res, 'BAD_REQUEST', 'Too many line items');

    const orderId = uid('ord');
    try {
      await tx(async (client) => {
        await q(client, 'INSERT INTO orders (id, branch_id, table_id, status) VALUES (?,?,?,?)', orderId, t.branch_id, t.id, 'new');
        for (const it of body.items) {
          const item = (await q(client, 'SELECT * FROM menu_items WHERE id = ? AND available = 1', it.itemId)).rows[0];
          if (!item) throw { code: 'ITEM_UNAVAILABLE', message: 'An item you selected is no longer available. Please refresh and re-order.' };
          let variantPrice = 0;
          let safeVariantId = null;
          if (it.variantId) {
            const v = (await q(client, 'SELECT * FROM menu_item_variants WHERE id = ? AND menu_item_id = ?', it.variantId, it.itemId)).rows[0];
            if (v) { variantPrice = Number(v.price_delta); safeVariantId = v.id; }
          }
          const qty = Math.min(99, Math.max(1, Math.floor(Number(it.quantity) || 1)));
          await q(client, 'INSERT INTO order_items (id, order_id, menu_item_id, variant_id, quantity, price_at_order) VALUES (?,?,?,?,?,?)',
            uid('oi'), orderId, it.itemId, safeVariantId, qty, Number(item.base_price) + variantPrice);
        }
        await q(client, "UPDATE tables SET status = 'occupied' WHERE id = ?", t.id);
      });
    } catch (e) {
      return err(res, e.code || 'ORDER_FAILED', e.message || 'Could not place order');
    }
    await db.prepare("UPDATE orders SET updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ?").run(orderId);
    return ok(res, { orderId, status: 'new', tableNumber: t.table_number });
  }

  // Public: customer order tracking (no auth — order id is a random 64-bit token)
  if (method === 'GET' && pathname.match(/^\/api\/orders\/([^/]+)\/track$/)) {
    const orderId = pathname.match(/^\/api\/orders\/([^/]+)\/track$/)[1];
    const order = await orderWithItems(orderId);
    if (!order) return err(res, 'NOT_FOUND', 'Order not found', 404);
    const branch = await db.prepare('SELECT name FROM branches WHERE id = ?').get(order.branch_id);
    const bill = await db.prepare(`
      SELECT id, subtotal, tax_amount, tax_rate_snapshot, service_charge, total, payment_status
      FROM bills b JOIN bill_orders bo ON bo.bill_id = b.id
      WHERE bo.order_id = ?
    `).get(orderId);
    return ok(res, {
      order: {
        id: order.id, status: order.status, tableNumber: order.table_number,
        branchId: order.branch_id, branchName: branch?.name, createdAt: order.created_at, updatedAt: order.updated_at,
        items: order.items.map(i => ({ name: i.item_name, variantName: i.variant_name, quantity: i.quantity, price: i.price_at_order })),
      },
      bill,
    });
  }

  // ---- Authed staff endpoints ----
  if (method === 'POST' && pathname === '/api/auth/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    const rl = await checkRateLimit(ip);
    if (!rl.allowed) return err(res, 'RATE_LIMITED', `Too many attempts. Try again in ${rl.retryAfter}s.`, 429);
    const body = await readBody(req);
    const staff = await db.prepare('SELECT * FROM staff_accounts WHERE username = ? AND active = 1').get(String(body.username || ''));
    if (!staff || !verifyPassword(String(body.password || ''), staff.password_hash)) {
      await recordFailure(ip);
      return err(res, 'BAD_CREDENTIALS', 'Invalid username or password');
    }
    await db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
    await createSession(staff, req, res);
    return ok(res, { username: staff.username, role: staff.role, branchId: staff.branch_id });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const s = await getSession(req);
    if (!s) return err(res, 'UNAUTHENTICATED', 'Please log in', 401);
    return ok(res, { username: s.username, role: s.role, branchId: s.branchId });
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const s = await getSession(req);
    if (s) await db.prepare('DELETE FROM sessions WHERE token = ?').run(s.token);
    res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
    return ok(res, {});
  }

  // Public: host to embed in QR codes (LAN address locally, public URL when hosted)
  if (method === 'GET' && pathname === '/api/host') {
    const publicUrl = process.env.PUBLIC_URL;
    const host = publicUrl ? publicUrl.replace(/^https?:\/\//, '') : `${lanAddress()}:${PORT}`;
    return ok(res, { host });
  }

  // Staff-only: table numbers + QR tokens (only for QR code generation)
  if (method === 'GET' && pathname === '/api/tables/numbers') {
    const s = await staffSession(req, res);
    if (!s) return;
    const branch = searchParams.get('branch');
    if (!branch || !await db.prepare('SELECT id FROM branches WHERE id = ?').get(branch)) return err(res, 'BAD_REQUEST', 'invalid branch');
    const rows = await db.prepare('SELECT id, table_number, token FROM tables WHERE branch_id = ? ORDER BY table_number').all(branch);
    return ok(res, { branch, tables: rows.map(r => ({ id: r.id, number: r.table_number, token: r.token })) });
  }

  // Staff-only: create a new table + QR token
  if (method === 'POST' && pathname === '/api/tables') {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s) return;
    const body = await readBody(req);
    const branch = String(body.branch || '');
    if (!branchScope(s, branch)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    const tableNumber = Math.floor(Number(body.tableNumber));
    if (!Number.isInteger(tableNumber) || tableNumber <= 0 || tableNumber > 9999) return err(res, 'BAD_REQUEST', 'Invalid table number');
    const dup = await db.prepare('SELECT id FROM tables WHERE branch_id = ? AND table_number = ?').get(branch, tableNumber);
    if (dup) return err(res, 'EXISTS', 'Table number already exists for this branch');
    const id = uid('tbl');
    const token = randomBytes(6).toString('hex');
    await db.prepare('INSERT INTO tables (id, branch_id, table_number, token) VALUES (?,?,?,?)').run(id, branch, tableNumber, token);
    return ok(res, { id, branch, number: tableNumber, token });
  }

  // Staff-only: change a table's number (QR token stays valid, QR data changes)
  if (method === 'PATCH' && pathname.match(/^\/api\/tables\/([^/]+)$/)) {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s) return;
    const tableId = pathname.match(/^\/api\/tables\/([^/]+)$/)[1];
    const table = await db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
    if (!table) return err(res, 'NOT_FOUND', 'Table not found', 404);
    if (!branchScope(s, table.branch_id)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    const body = await readBody(req);
    const tableNumber = Math.floor(Number(body.tableNumber));
    if (!Number.isInteger(tableNumber) || tableNumber <= 0 || tableNumber > 9999) return err(res, 'BAD_REQUEST', 'Invalid table number');
    if (tableNumber !== table.table_number) {
      const dup = await db.prepare('SELECT id FROM tables WHERE branch_id = ? AND table_number = ?').get(table.branch_id, tableNumber);
      if (dup) return err(res, 'EXISTS', 'Table number already exists for this branch');
      await db.prepare('UPDATE tables SET table_number = ? WHERE id = ?').run(tableNumber, tableId);
    }
    return ok(res, { id: tableId, branch: table.branch_id, number: tableNumber, token: table.token });
  }

  // Orders list (kitchen/reception)
  if (method === 'GET' && pathname === '/api/orders') {
    const s = await staffSession(req, res);
    if (!s) return;
    const branch = searchParams.get('branch');
    if (!branchScope(s, branch)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    await reviewJob();
    const status = searchParams.get('status');
    const rows = status
      ? await db.prepare('SELECT id FROM orders WHERE branch_id = ? AND status = ? ORDER BY created_at LIMIT 100').all(branch, status)
      : await db.prepare('SELECT id FROM orders WHERE branch_id = ? ORDER BY created_at DESC LIMIT 100').all(branch);
    const orders = [];
    for (const r of rows) orders.push(await orderWithItems(r.id));
    return ok(res, orders);
  }

  // Tables (reception)
  if (method === 'GET' && pathname === '/api/tables') {
    const s = await staffSession(req, res);
    if (!s) return;
    const branch = searchParams.get('branch');
    if (!branchScope(s, branch)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    const tables = await db.prepare('SELECT * FROM tables WHERE branch_id = ? ORDER BY table_number').all(branch);
    const result = [];
    for (const t of tables) {
      const orderCount = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE table_id = ? AND status != 'delivered'").get(t.id);
      const activeBills = await db.prepare("SELECT id, total, payment_status FROM bills WHERE table_id = ? AND payment_status = 'pending'").all(t.id);
      result.push({ ...t, activeOrderCount: Number(orderCount.n), pendingBills: activeBills });
    }
    return ok(res, result);
  }

  // Order status update (kitchen) — sequential state machine, no skipping
  if (method === 'PATCH' && pathname.match(/^\/api\/orders\/([^/]+)\/status$/)) {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s) return;
    const orderId = pathname.match(/^\/api\/orders\/([^/]+)\/status$/)[1];
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return err(res, 'NOT_FOUND', 'Order not found', 404);
    if (!branchScope(s, order.branch_id)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    const body = await readBody(req);
    const target = String(body.status || '');
    if (NEXT_STATUS[order.status] !== target) return err(res, 'BAD_TRANSITION', `Cannot go ${order.status} → ${target}`);
    await db.prepare("UPDATE orders SET status = ?, updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ?").run(target, orderId);
    return ok(res, await orderWithItems(orderId));
  }

  // Single-step undo within 60s
  if (method === 'POST' && pathname.match(/^\/api\/orders\/([^/]+)\/undo$/)) {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s) return;
    const orderId = pathname.match(/^\/api\/orders\/([^/]+)\/undo$/)[1];
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return err(res, 'NOT_FOUND', 'Order not found', 404);
    if (!branchScope(s, order.branch_id)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    const ageSec = (Date.now() - new Date(order.updated_at + 'Z').getTime()) / 1000;
    if (ageSec > 60) return err(res, 'UNDO_WINDOW', 'Undo window (60s) has passed');
    const prev = PREV_STATUS[order.status];
    if (!prev) return err(res, 'NO_UNDO', 'Nothing to undo');
    await db.prepare("UPDATE orders SET status = ?, updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ?").run(prev, orderId);
    return ok(res, await orderWithItems(orderId));
  }

  // Generate bill (reception) — only from delivered orders
  if (method === 'POST' && pathname === '/api/bills/generate') {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s) return;
    const body = await readBody(req);
    const table = await db.prepare('SELECT * FROM tables WHERE id = ?').get(body.tableId);
    if (!table) return err(res, 'NOT_FOUND', 'Table not found', 404);
    if (!branchScope(s, table.branch_id)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    const existing = await db.prepare("SELECT * FROM bills WHERE table_id = ? AND payment_status = 'pending'").get(table.id);
    if (existing) return ok(res, await getBill(existing.id));

    const delivered = await db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'delivered' AND id NOT IN (SELECT order_id FROM bill_orders)").all(table.id);
    if (delivered.length === 0) return err(res, 'NO_DELIVERED', 'No delivered orders to bill for this table');

    const taxRate = await getTaxRate();
    const serviceCharge = await getServiceCharge();
    let subtotal = 0;
    const lines = [];
    for (const o of delivered) {
      const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
      for (const it of items) {
        subtotal += Number(it.price_at_order) * Number(it.quantity);
        const mi = await db.prepare('SELECT name FROM menu_items WHERE id = ?').get(it.menu_item_id);
        lines.push({ name: mi.name, quantity: it.quantity, price: Number(it.price_at_order) });
      }
    }
    const taxAmount = Math.round(subtotal * taxRate / 100);
    const total = subtotal + taxAmount + serviceCharge;
    const billId = uid('bill');

    try {
      await tx(async (client) => {
        await q(client, 'INSERT INTO bills (id, table_id, branch_id, subtotal, tax_amount, tax_rate_snapshot, service_charge, total) VALUES (?,?,?,?,?,?,?,?)',
          billId, table.id, table.branch_id, subtotal, taxAmount, taxRate, serviceCharge, total);
        for (const o of delivered) await q(client, 'INSERT INTO bill_orders (bill_id, order_id) VALUES (?,?)', billId, o.id);
        await q(client, 'UPDATE tables SET locked = 1 WHERE id = ?', table.id);
      });
    } catch (e) { return err(res, 'BILL_FAILED', 'Could not generate bill'); }
    return ok(res, await getBill(billId));
  }

  // Mark bill paid (reception)
  if (method === 'PATCH' && pathname.match(/^\/api\/bills\/([^/]+)\/pay$/)) {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s) return;
    const billId = pathname.match(/^\/api\/bills\/([^/]+)\/pay$/)[1];
    const bill = await db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    if (!bill) return err(res, 'NOT_FOUND', 'Bill not found', 404);
    if (!branchScope(s, bill.branch_id)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    if (bill.payment_status === 'paid') return err(res, 'ALREADY_PAID', 'Bill already paid');
    const body = await readBody(req);
    const methodPay = ['cash', 'upi', 'card'].includes(body.method) ? body.method : 'cash';
    const phone = String(body.customerPhone || '').replace(/\D/g, '');

    try {
      await tx(async (client) => {
        const r = await q(client, "UPDATE bills SET payment_status = 'paid', payment_method = ?, customer_phone = ?, paid_at = (now() AT TIME ZONE 'UTC') WHERE id = ? AND payment_status = 'pending'",
          methodPay, phone || null, billId);
        if (r.rowCount === 0) throw { code: 'ALREADY_PAID', message: 'Bill already paid' };
        await q(client, "UPDATE tables SET status = 'available', locked = 0 WHERE id = ?", bill.table_id);
      });
    } catch (e) { return err(res, e.code || 'PAY_FAILED', e.message || 'Could not mark bill paid'); }

    const paid = await getBill(billId);
    notifyInvoice(paid).catch(e => console.error('[notify]', e.message)); // don't block the response on a Meta API call
    return ok(res, paid);
  }

  // Bill detail
  if (method === 'GET' && pathname.match(/^\/api\/bills\/([^/]+)$/)) {
    const s = await staffSession(req, res);
    if (!s) return;
    const billId = pathname.match(/^\/api\/bills\/([^/]+)$/)[1];
    const bill = await getBill(billId);
    if (!bill) return err(res, 'NOT_FOUND', 'Bill not found', 404);
    if (!branchScope(s, bill.branch_id)) return err(res, 'FORBIDDEN', 'Not allowed for this branch', 403);
    return ok(res, bill);
  }

  // ---- Admin endpoints ----
  if (method === 'GET' && pathname === '/api/admin/revenue') {
    const s = await staffSession(req, res);
    if (!s || s.role !== 'admin') return err(res, 'FORBIDDEN', 'Admin only', 403);
    const period = searchParams.get('period') || 'week';
    const branch = searchParams.get('branch');
    // Calendar periods in IST — paid_at is stored in UTC, so convert before truncating.
    const trunc = { day: 'day', week: 'week', month: 'month' }[period] || 'week';
    const since = (await db.prepare(`SELECT date_trunc('${trunc}', now() AT TIME ZONE 'Asia/Kolkata')::date AS since`).get())?.since;
    const rows = await db.prepare(`
      SELECT b.branch_id, br.name AS branch_name, COUNT(*) AS bill_count, SUM(b.total) AS revenue
      FROM bills b JOIN branches br ON br.id = b.branch_id
      WHERE b.payment_status = 'paid'
        AND (b.paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' >= date_trunc('${trunc}', now() AT TIME ZONE 'Asia/Kolkata')
      ${branch ? 'AND b.branch_id = ?' : ''}
      GROUP BY b.branch_id, br.name
    `).all(...(branch ? [branch] : []));
    const total = rows.reduce((sum, r) => sum + Number(r.revenue || 0), 0);
    return ok(res, { period, since, byBranch: rows, totalOrders: rows.reduce((sum, r) => sum + Number(r.bill_count), 0), totalRevenue: total });
  }

  if (method === 'GET' && pathname === '/api/admin/config') {
    const s = await staffSession(req, res);
    if (!s || s.role !== 'admin') return err(res, 'FORBIDDEN', 'Admin only', 403);
    return ok(res, { taxRate: await getTaxRate(), serviceCharge: await getServiceCharge() });
  }

  if (method === 'PUT' && pathname === '/api/admin/config') {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s || s.role !== 'admin') return err(res, 'FORBIDDEN', 'Admin only', 403);
    const body = await readBody(req);
    const taxRate = Number(body.taxRate);
    const serviceCharge = Number(body.serviceCharge);
    if (body.taxRate != null && taxRate >= 0 && taxRate <= 100) await setSetting('tax_rate', String(taxRate));
    if (body.serviceCharge != null && serviceCharge >= 0 && serviceCharge <= 100000) await setSetting('service_charge', String(serviceCharge));
    return ok(res, { taxRate: await getTaxRate(), serviceCharge: await getServiceCharge() });
  }

  if (method === 'PUT' && pathname === '/api/admin/menu') {
    if (!checkOrigin(req, res)) return;
    const s = await staffSession(req, res);
    if (!s || s.role !== 'admin') return err(res, 'FORBIDDEN', 'Admin only', 403);
    const body = await readBody(req);
    const item = await db.prepare('SELECT * FROM menu_items WHERE id = ?').get(body.itemId);
    if (!item) return err(res, 'NOT_FOUND', 'Item not found', 404);
    await db.prepare('UPDATE menu_items SET name = ?, base_price = ?, available = ?, is_veg = ? WHERE id = ?')
      .run(body.name ?? item.name, body.price ?? item.base_price, body.available ?? item.available, body.isVeg ?? item.is_veg, body.itemId);
    return ok(res, await db.prepare('SELECT * FROM menu_items WHERE id = ?').get(body.itemId));
  }

  err(res, 'NOT_FOUND', 'Not found', 404);
  } catch (e) {
    console.error('[handler]', e.message);
    if (!res.headersSent) err(res, 'INTERNAL', 'Internal error', 500);
  }
}
