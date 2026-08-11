import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { db, pool, tx, q, seed, uid, verifyPassword, getTaxRate, getServiceCharge, setSetting } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000;

await seed();

// ---------- Sessions (DB-backed — survives serverless cold starts) ----------
async function createSession(staff, res) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, staff_id, exp) VALUES (?,?,?)').run(token, staff.id, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}

async function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('sid='));
  if (!cookie) return null;
  const token = cookie.slice(4);
  const s = await db.prepare(`
    SELECT s.token, s.staff_id, s.exp, st.username, st.role, st.branch_id
    FROM sessions s JOIN staff_accounts st ON st.id = s.staff_id
    WHERE s.token = ?
  `).get(token);
  if (!s) return null;
  if (Date.now() > Number(s.exp)) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { token, staffId: s.staff_id, username: s.username, role: s.role, branchId: s.branch_id, exp: Number(s.exp) };
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
  await db.prepare('INSERT INTO login_attempts (ip, count) VALUES (?,1) ON CONFLICT (ip) DO UPDATE SET count = login_attempts.count + 1').run(ip);
  const r = await db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
  if (r.count >= MAX_ATTEMPTS) {
    await db.prepare('UPDATE login_attempts SET lock_until = ?, count = 0 WHERE ip = ?').run(Date.now() + LOCK_MS, ip);
  }
}

// ---------- Helpers ----------
const money = (p) => `₹${(p / 100).toFixed(2)}`;
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
  if (origin && !origin.includes(req.headers.host)) { err(res, 'CSRF', 'Forbidden', 403); return false; }
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

// ---------- Notifications (WhatsApp stub per PRD) ----------
async function notifyInvoice(bill) {
  if (!bill.customer_phone) return;
  const log = (status) => db.prepare('INSERT INTO notification_log (id, bill_id, type, phone, status) VALUES (?,?,?,?,?)').run(uid('ntf'), bill.id, 'invoice', bill.customer_phone, status);
  const okSend = Math.random() > 0.05; // ~5% failure to exercise retry path
  await log(okSend ? 'sent' : 'failed');
  if (!okSend) {
    const okRetry = Math.random() > 0.5;
    await log(okRetry ? 'sent' : 'failed');
    if (!okRetry) await db.prepare('UPDATE bills SET notif_failed = 1 WHERE id = ?').run(bill.id);
  }
  console.log(`[notify] invoice for bill ${bill.id} -> ${bill.customer_phone}`);
}

// Review request: once per phone + date, ~24h after payment.
// No background process on Vercel — runs lazily on staff page polls.
async function reviewJob() {
  const due = await db.prepare(`
    SELECT b.id, b.customer_phone, substr(b.paid_at::text,1,10) AS paid_date FROM bills b
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
    await db.prepare("INSERT INTO notification_log (id, bill_id, type, phone, status) VALUES (?,?,?,?,?)").run(uid('ntf'), r.id, 'review_request', r.customer_phone, 'sent');
    console.log(`[notify] review request bill ${r.id} -> ${r.customer_phone} (paid ${r.paid_date})`);
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
    res.writeHead(302, { Location: '/b/alkapuri/1' });
    res.end();
    return;
  }
  const pageMatch = pathname.match(/^\/b\/([\w-]+)\/(\d+)$/);
  if (method === 'GET' && pageMatch) {
    const t = await getTableWithBranch(pageMatch[1], Number(pageMatch[2]));
    if (!t) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'invalid-qr.html'))); return; }
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

  // Public: create order
  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    const t = await getTableWithBranch(String(body.branch || ''), Number(body.tableNumber));
    if (!t) return err(res, 'BAD_TABLE', 'This QR code is not valid. Please ask staff for help.');
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM bills WHERE table_id = ? AND payment_status = 'pending'").get(t.id);
    if (t.locked || Number(pending.n) > 0) {
      return err(res, 'TABLE_LOCKED', 'This table is currently being billed. Please ask staff.');
    }
    if (!Array.isArray(body.items) || body.items.length === 0) return err(res, 'BAD_REQUEST', 'No items in order');

    const orderId = uid('ord');
    try {
      await tx(async (client) => {
        await q(client, 'INSERT INTO orders (id, branch_id, table_id, status) VALUES (?,?,?,?)', orderId, t.branch_id, t.id, 'new');
        for (const it of body.items) {
          const item = (await q(client, 'SELECT * FROM menu_items WHERE id = ? AND available = 1', it.itemId)).rows[0];
          if (!item) throw { code: 'ITEM_UNAVAILABLE', message: 'An item you selected is no longer available. Please refresh and re-order.' };
          let variantPrice = 0;
          if (it.variantId) {
            const v = (await q(client, 'SELECT * FROM menu_item_variants WHERE id = ? AND menu_item_id = ?', it.variantId, it.itemId)).rows[0];
            if (v) variantPrice = Number(v.price_delta);
          }
          const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
          await q(client, 'INSERT INTO order_items (id, order_id, menu_item_id, variant_id, quantity, price_at_order) VALUES (?,?,?,?,?,?)',
            uid('oi'), orderId, it.itemId, it.variantId || null, qty, Number(item.base_price) + variantPrice);
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
    await createSession(staff, res);
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
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return ok(res, {});
  }

  // Public: host to embed in QR codes (LAN address locally, public URL when hosted)
  if (method === 'GET' && pathname === '/api/host') {
    const publicUrl = process.env.PUBLIC_URL;
    const host = publicUrl ? publicUrl.replace(/^https?:\/\//, '') : `${lanAddress()}:${PORT}`;
    return ok(res, { host });
  }

  // Public: table numbers for QR codes (only numbers — no occupancy/billing data)
  if (method === 'GET' && pathname === '/api/tables/numbers') {
    const branch = searchParams.get('branch');
    if (!branch || !await db.prepare('SELECT id FROM branches WHERE id = ?').get(branch)) return err(res, 'BAD_REQUEST', 'invalid branch');
    const rows = await db.prepare('SELECT table_number FROM tables WHERE branch_id = ? ORDER BY table_number').all(branch);
    return ok(res, { branch, tables: rows.map(r => r.table_number) });
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
      ? await db.prepare('SELECT id FROM orders WHERE branch_id = ? AND status = ? ORDER BY created_at').all(branch, status)
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

    const delivered = await db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'delivered'").all(table.id);
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
        await q(client, "UPDATE bills SET payment_status = 'paid', payment_method = ?, customer_phone = ?, paid_at = (now() AT TIME ZONE 'UTC') WHERE id = ?",
          methodPay, phone || null, billId);
        await q(client, "UPDATE tables SET status = 'available', locked = 0 WHERE id = ?", bill.table_id);
      });
    } catch (e) { return err(res, 'PAY_FAILED', 'Could not mark bill paid'); }

    const paid = await getBill(billId);
    await notifyInvoice(paid); // stub — logs to notification_log, retries once on failure
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
    const days = { day: 1, week: 7, month: 30 }[period] || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = await db.prepare(`
      SELECT b.branch_id, br.name AS branch_name, COUNT(*) AS bill_count, SUM(b.total) AS revenue
      FROM bills b JOIN branches br ON br.id = b.branch_id
      WHERE b.payment_status = 'paid' AND substr(b.paid_at::text,1,10) >= ?
      ${branch ? 'AND b.branch_id = ?' : ''}
      GROUP BY b.branch_id, br.name
    `).all(since, ...(branch ? [branch] : []));
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
    if (body.taxRate != null && body.taxRate >= 0) await setSetting('tax_rate', String(body.taxRate));
    if (body.serviceCharge != null && body.serviceCharge >= 0) await setSetting('service_charge', String(body.serviceCharge));
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
