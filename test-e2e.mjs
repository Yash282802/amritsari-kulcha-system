const BASE = 'http://localhost:4000';

async function j(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

async function run() {
  const loginResp = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'kitchen_alkapuri', password: 'kitchen123' }) });
  const sid = loginResp.headers.get('set-cookie').split(';')[0];
  const login = await loginResp.json();
  console.log('login:', loginResp.status, login.success ? login.data.role : login.error);
  console.log('cookie:', sid.slice(0, 10) + '...');

  const bad = await j('POST', '/api/auth/login', { username: 'kitchen_alkapuri', password: 'nope' });
  console.log('bad login rejected:', bad.status === 400);

  const menu = (await j('GET', '/api/catalog/menu?branch=alkapuri')).data.data;
  const item1 = menu.items[0], item2 = menu.items[4];
  const order = await j('POST', '/api/orders', { branch: 'alkapuri', tableNumber: 3, items: [{ itemId: item1.id, quantity: 2, variantId: item1.variants[0]?.id }, { itemId: item2.id, quantity: 1 }] });
  console.log('order placed:', order.data.data.orderId ? 'OK' : order.data);
  const orderId = order.data.data.orderId;

  const queue = await j('GET', `/api/orders?branch=alkapuri`, null, sid);
  const o = queue.data.data.find(x => x.id === orderId);
  console.log('kitchen queue sees order:', o.status === 'new', 'items:', o.items.length, 'price_snapshot:', o.items[0].price_at_order);

  const t1 = await j('PATCH', `/api/orders/${orderId}/status`, { status: 'delivered' }, sid);
  console.log('skip new→delivered rejected:', t1.status === 400);
  await j('PATCH', `/api/orders/${orderId}/status`, { status: 'preparing' }, sid);
  await j('PATCH', `/api/orders/${orderId}/status`, { status: 'ready' }, sid);
  const done = await j('PATCH', `/api/orders/${orderId}/status`, { status: 'delivered' }, sid);
  console.log('new→preparing→ready→delivered OK:', done.data.data.status === 'delivered');

  const undo = await j('POST', `/api/orders/${orderId}/undo`, {}, sid);
  console.log('undo allowed:', undo.data.data.status === 'ready');
  await j('PATCH', `/api/orders/${orderId}/status`, { status: 'delivered' }, sid);

  const login2 = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'kitchen_gorwa', password: 'kitchen123' }) });
  const sid2 = login2.headers.get('set-cookie').split(';')[0];
  const forbidden = await j('PATCH', `/api/orders/${orderId}/status`, { status: 'ready' }, sid2);
  console.log('cross-branch blocked:', forbidden.status === 403);

  const loginR = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reception_alkapuri', password: 'reception123' }) });
  const sidR = loginR.headers.get('set-cookie').split(';')[0];
  const tables = (await j('GET', '/api/tables?branch=alkapuri', null, sidR)).data.data;
  const table = tables.find(t => t.table_number === 3);
  console.log('table occupied:', table.status === 'occupied');
  const bill = await j('POST', '/api/bills/generate', { tableId: table.id }, sidR);
  console.log('bill generated:', bill.data.data.billId ? `subtotal=${bill.data.data.subtotal} tax=${bill.data.data.tax_amount} total=${bill.data.data.total}` : bill.data);

  const blockedOrder = await j('POST', '/api/orders', { branch: 'alkapuri', tableNumber: 3, items: [{ itemId: item1.id, quantity: 1 }] });
  console.log('order blocked while billing:', blockedOrder.status === 400);

  const pay = await j('PATCH', `/api/bills/${bill.data.data.id}/pay`, { method: 'upi', customerPhone: '9876543210' }, sidR);
  console.log('bill paid:', pay.data.data.payment_status === 'paid');

  const tables2 = (await j('GET', '/api/tables?branch=alkapuri', null, sidR)).data.data;
  console.log('table available after pay:', tables2.find(t => t.table_number === 3).status === 'available');

  const loginA = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'owner123' }) });
  const sidA = loginA.headers.get('set-cookie').split(';')[0];
  const rev = await j('GET', '/api/admin/revenue?period=day', null, sidA);
  console.log('admin revenue:', rev.data.data.totalRevenue === bill.data.data.total ? 'matches bill' : rev.data);
  const revBad = await j('GET', '/api/admin/revenue?period=day', null, sidR);
  console.log('reception blocked from admin:', revBad.status === 403);

  console.log('\nALL FLOW CHECKS DONE');
}
run().catch(e => { console.error('FATAL', e); process.exit(1); });
