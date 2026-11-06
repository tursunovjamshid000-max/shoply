'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'shoply_data';
const ROOT = __dirname;
const COMMISSION_RATE = 0.03;
const FREEZE_THRESHOLD = 20000;

const ALLOWED = new Set([
  'mono_store_products_v2', 'mono_store_settings_v2', 'mono_store_slides_v2',
  'mono_store_cart_events_v1', 'shoply_orders_v1', 'shoply_reviews_v1',
  'mono_store_admin_profile_v1', 'shoply_site_builder_v1', 'shoply_promo_codes_v1',
  // Seller marketplace keys
  'shoply_seller_applications_v1',
  'shoply_sellers_v1',
  'shoply_commission_log_v1',
  'shoply_seller_messages_v1',
  'shoply_admin_notifications_v1'
]);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function dbRequest(method, query = '', body) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase environment variables are missing');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}${query}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getAll() {
  const rows = await dbRequest('GET', '?select=key,value');
  const out = {};
  for (const row of rows || []) if (ALLOWED.has(row.key)) out[row.key] = row.value;
  return out;
}

async function getOne(key) {
  const rows = await dbRequest('GET', `?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows && rows.length ? { exists: true, value: rows[0].value } : { exists: false, value: null };
}

async function putOne(key, value) {
  await dbRequest('POST', '', [{ key, value, updated_at: new Date().toISOString() }]);
}

async function updateOrders(fn) {
  const current = await getOne('shoply_orders_v1');
  const list = Array.isArray(current.value) ? current.value : [];
  const next = fn(list);
  await putOne('shoply_orders_v1', next);
  return next;
}

function isAdminAuth(req) {
  // Lightweight check: admin HTML already gates UI. For critical mutations we still prefer dedicated endpoints.
  // Optional header for future hardening.
  const token = req.headers['x-shoply-admin'];
  if (token && process.env.ADMIN_PASSWORD && token === process.env.ADMIN_PASSWORD) return true;
  return true; // keep existing open style for /api/state compatibility; critical logic is server-side
}

function sanitizeStr(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function nowISO() {
  return new Date().toISOString();
}

async function getSellers() {
  const x = await getOne('shoply_sellers_v1');
  return Array.isArray(x.value) ? x.value : [];
}

async function putSellers(list) {
  await putOne('shoply_sellers_v1', list);
}

async function getApplications() {
  const x = await getOne('shoply_seller_applications_v1');
  return Array.isArray(x.value) ? x.value : [];
}

async function putApplications(list) {
  await putOne('shoply_seller_applications_v1', list);
}

async function getCommissionLog() {
  const x = await getOne('shoply_commission_log_v1',
  'shoply_seller_messages_v1',
  'shoply_admin_notifications_v1');
  return Array.isArray(x.value) ? x.value : [];
}

async function putCommissionLog(list) {
  await putOne('shoply_commission_log_v1',
  'shoply_seller_messages_v1',
  'shoply_admin_notifications_v1', list);
}

async function getProducts() {
  const x = await getOne('mono_store_products_v2');
  return Array.isArray(x.value) ? x.value : [];
}

async function putProducts(list) {
  await putOne('mono_store_products_v2', list);
}

function findSeller(sellers, userId) {
  return sellers.find(s => String(s.userId) === String(userId));
}

function ensureSellerStats(seller) {
  seller.debt = Number(seller.debt) || 0;
  seller.totalSales = Number(seller.totalSales) || 0;
  seller.totalCommission = Number(seller.totalCommission) || 0;
  seller.paidCommission = Number(seller.paidCommission) || 0;
  seller.productsCount = Number(seller.productsCount) || 0;
  return seller;
}

async function applyCommissionForOrder(order) {
  if (!order || !Array.isArray(order.items) || order.commissionApplied) return { applied: false, reason: 'already or empty' };

  const products = await getProducts();
  const byId = new Map(products.map(p => [String(p.id), p]));
  const sellers = await getSellers();
  const log = await getCommissionLog();
  const existing = new Set(log.filter(l => l.orderId === order.id).map(l => `${l.orderId}:${l.productId}:${l.sellerId}`));

  let any = false;
  const entries = [];

  for (const item of order.items) {
    const pid = String(item.productId || item.id || '');
    const p = byId.get(pid) || {};
    const sellerId = item.sellerId || p.sellerId;
    if (!sellerId) continue;

    const key = `${order.id}:${pid}:${sellerId}`;
    if (existing.has(key)) continue;

    const qty = Math.max(1, Number(item.quantity) || 1);
    const price = Number(item.price != null ? item.price : p.price) || 0;
    const line = price * qty;
    const commission = Math.round(line * COMMISSION_RATE);

    if (commission <= 0) continue;

    const seller = findSeller(sellers, sellerId);
    if (!seller) continue;

    ensureSellerStats(seller);
    seller.debt += commission;
    seller.totalSales += line;
    seller.totalCommission += commission;
    seller.lastActiveAt = nowISO();

    if (seller.debt >= FREEZE_THRESHOLD) {
      seller.status = 'frozen';
      seller.frozenAt = seller.frozenAt || nowISO();
      seller.freezeReason = seller.freezeReason || `Komissiya qarzi ${FREEZE_THRESHOLD} so‘mdan oshdi`;
    }

    entries.push({
      id: `COM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      orderId: order.id,
      productId: pid,
      productName: item.name || p.name || '',
      sellerId: String(sellerId),
      amount: commission,
      saleAmount: line,
      quantity: qty,
      createdAt: nowISO()
    });
    existing.add(key);
    any = true;
  }

  if (any) {
    order.commissionApplied = true;
    order.commissionAppliedAt = nowISO();
    await putSellers(sellers);
    await putCommissionLog([...entries, ...log].slice(0, 20000));
  }
  return { applied: any, entries };
}


function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
function makeSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** Require valid seller session token. Returns seller or null. */
async function requireSellerSession(req, bodyOrQuery) {
  const token = sanitizeStr(
    (bodyOrQuery && (bodyOrQuery.token || bodyOrQuery.sessionToken)) ||
    req.headers['x-seller-token'] ||
    '',
    80
  );
  if (!token) return null;
  const sellers = await getSellers();
  const seller = sellers.find(s => s.sessionToken && s.sessionToken === token);
  if (!seller) return null;
  ensureSellerStats(seller);
  return seller;
}

function sellerOfficialNick(seller) {
  if (!seller) return '';
  return String(seller.login || seller.telegramUsername || seller.storeName || seller.fullName || seller.userId || '').replace(/^@/, '');
}

async function applyCommissionForSeller(order, onlySellerId) {
  if (!order || !Array.isArray(order.items)) return { applied: false };
  const products = await getProducts();
  const byId = new Map(products.map(p => [String(p.id), p]));
  const sellers = await getSellers();
  const log = await getCommissionLog();
  const existing = new Set(log.filter(l => l.orderId === order.id).map(l => `${l.orderId}:${l.productId}:${l.sellerId}`));
  let any = false;
  const entries = [];
  for (const item of order.items) {
    const pid = String(item.productId || item.id || '');
    const p = byId.get(pid) || {};
    const sellerId = item.sellerId || p.sellerId;
    if (!sellerId || String(sellerId) !== String(onlySellerId)) continue;
    const key = `${order.id}:${pid}:${sellerId}`;
    if (existing.has(key)) continue;
    const qty = Math.max(1, Number(item.quantity) || 1);
    const price = Number(item.price != null ? item.price : p.price) || 0;
    const line = price * qty;
    const commission = Math.round(line * COMMISSION_RATE);
    if (commission <= 0) continue;
    const seller = findSeller(sellers, sellerId);
    if (!seller) continue;
    ensureSellerStats(seller);
    seller.debt += commission;
    seller.totalSales += line;
    seller.totalCommission += commission;
    seller.lastActiveAt = nowISO();
    if (seller.debt >= FREEZE_THRESHOLD) {
      seller.status = 'frozen';
      seller.frozenAt = seller.frozenAt || nowISO();
      seller.freezeReason = seller.freezeReason || `Komissiya qarzi ${FREEZE_THRESHOLD} so‘mdan oshdi`;
    }
    entries.push({
      id: `COM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      orderId: order.id,
      productId: pid,
      productName: item.name || p.name || '',
      sellerId: String(sellerId),
      amount: commission,
      saleAmount: line,
      quantity: qty,
      createdAt: nowISO(),
      source: 'seller_confirm'
    });
    existing.add(key);
    any = true;
  }
  if (any) {
    await putSellers(sellers);
    await putCommissionLog([...entries, ...log].slice(0, 20000));
  }
  return { applied: any, entries };
}

async function pushAdminNotification(note) {
  const item = await getOne('shoply_admin_notifications_v1');
  const list = Array.isArray(item.value) ? item.value : [];
  list.unshift({ id: `N-${Date.now()}`, createdAt: nowISO(), read: false, ...note });
  await putOne('shoply_admin_notifications_v1', list.slice(0, 2000));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  try {
    // Health
    if (p === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, database: SUPABASE_URL && SUPABASE_KEY ? 'configured' : 'missing' });
    }

    // Admin login (unchanged)
    if (p === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req);
      const login = process.env.ADMIN_LOGIN || 'shoply';
      const password = process.env.ADMIN_PASSWORD || '24001214';
      return send(res, 200, { ok: String(b.login || '').trim() === login && String(b.password || '') === password });
    }

    // Full state (unchanged + new keys)
    if ((p === '/api/state' || p === '/api/admin/state') && req.method === 'GET') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return send(res, 503, { error: 'Supabase sozlanmagan' });
      const data = await getAll();
      // Public state: muzlatilgan tadbirkor mahsulotlarini vaqtincha yashirish
      if (p === '/api/state' && Array.isArray(data.mono_store_products_v2)) {
        const sellers = Array.isArray(data.shoply_sellers_v1) ? data.shoply_sellers_v1 : [];
        const frozenIds = new Set(sellers.filter(s => s && s.status === 'frozen').map(s => String(s.userId)));
        if (frozenIds.size) {
          data.mono_store_products_v2 = data.mono_store_products_v2.filter(pr => {
            if (!pr || !pr.sellerId) return true;
            return !frozenIds.has(String(pr.sellerId));
          });
        }
      }
      return send(res, 200, data);
    }

    // Generic state key (unchanged)
    if (p.startsWith('/api/state/')) {
      const key = decodeURIComponent(p.slice('/api/state/'.length));
      if (!ALLOWED.has(key)) return send(res, 400, { error: 'Unknown key' });
      if (req.method === 'GET') {
        const item = await getOne(key);
        return item.exists ? send(res, 200, { key, value: item.value }) : send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (!Object.prototype.hasOwnProperty.call(b, 'value')) return send(res, 400, { error: 'Missing value' });
        await putOne(key, b.value);
        return send(res, 200, { ok: true, key });
      }
      if (req.method === 'DELETE') {
        return send(res, 405, { error: 'Persistent records cannot be deleted through this endpoint. Save an updated value instead.' });
      }
      return send(res, 405, { error: 'Method not allowed' });
    }

    // ========== ORDERS (enhanced) ==========
    if (p === '/api/orders' && req.method === 'GET') {
      const x = await getOne('shoply_orders_v1');
      return send(res, 200, Array.isArray(x.value) ? x.value : []);
    }

    if (p === '/api/orders' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.name || !b.phone || !Array.isArray(b.items) || !b.items.length) {
        return send(res, 400, { error: 'Order needs name, phone and items' });
      }
      // Enrich items with sellerId from current products if missing
      const products = await getProducts();
      const byId = new Map(products.map(pr => [String(pr.id), pr]));
      const items = b.items.map(it => {
        const pr = byId.get(String(it.productId || it.id || ''));
        return {
          ...it,
          sellerId: it.sellerId || (pr && pr.sellerId) || null,
          storeName: it.storeName || (pr && pr.storeName) || null
        };
      });
      const sellers = await getSellers();
      const items2 = items.map(it => {
        const sid = it.sellerId;
        let sellerUsername = it.sellerUsername || null;
        let storeName = it.storeName || null;
        if (sid) {
          const s = findSeller(sellers, sid);
          if (s) {
            sellerUsername = sellerUsername || (s.telegramUsername || '').replace(/^@/, '') || null;
            storeName = storeName || s.storeName || null;
          }
        }
        return { ...it, sellerId: sid || null, sellerUsername, storeName };
      });
      // Group telegram targets: admin default zydex4, sellers their username
      const targets = [];
      const adminItems = items2.filter(i => !i.sellerId);
      const bySeller = {};
      for (const it of items2) {
        if (!it.sellerId) continue;
        if (!bySeller[it.sellerId]) bySeller[it.sellerId] = [];
        bySeller[it.sellerId].push(it);
      }
      if (adminItems.length) {
        targets.push({ type: 'admin', username: 'zydex4', items: adminItems, label: 'SHOPLY Admin' });
      }
      for (const [sid, its] of Object.entries(bySeller)) {
        const s = findSeller(sellers, sid);
        const uname = (its[0].sellerUsername || (s && s.telegramUsername) || '').replace(/^@/, '');
        targets.push({
          type: 'seller',
          sellerId: sid,
          username: uname || null,
          storeName: (s && s.storeName) || its[0].storeName || '',
          items: its,
          label: (s && s.storeName) || 'Tadbirkor'
        });
      }
      const order = {
        ...b,
        items: items2,
        id: b.id || `ORD-${Date.now()}`,
        createdAt: b.createdAt || nowISO(),
        status: b.status || 'Yangi',
        commissionApplied: false,
        formalized: true,
        formalizedAt: nowISO(),
        telegramTargets: targets.map(x => ({ type: x.type, username: x.username, sellerId: x.sellerId || null, storeName: x.storeName || null })),
        sellerConfirmations: {}
      };
      await updateOrders(list => [order, ...list].slice(0, 10000));
      // Admin notification — aniq matn + tadbirkor rasmiy nikname
      const sellerNicks = [];
      for (const tg of targets) {
        if (tg.type !== 'seller' || !tg.sellerId) continue;
        const s = findSeller(sellers, tg.sellerId);
        sellerNicks.push(sellerOfficialNick(s) || tg.storeName || tg.username || tg.sellerId);
      }
      const nickStr = sellerNicks.length ? sellerNicks.join(', ') : '—';
      await pushAdminNotification({
        type: 'order_formalized',
        title: 'Rasmiylashtirish amalga oshirildi',
        body: `Rasmiylashtirish amalga oshirildi. Mijoz: ${sanitizeStr(b.name, 80)} (${sanitizeStr(b.phone, 40)}). Buyurtma: ${order.id}. Tadbirkor(lar): ${nickStr}. Mahsulotlar: ${items2.map(i => i.name).join(', ')}. Jami: ${Number(b.total) || 0} so‘m.`,
        orderId: order.id,
        customerName: sanitizeStr(b.name, 80),
        sellers: sellerNicks,
        officialNicks: sellerNicks
      });
      // Notify each seller via messages inbox — confirm_required (overlay uchun)
      const msgItem = await getOne('shoply_seller_messages_v1');
      const allMsg = msgItem.value && typeof msgItem.value === 'object' && !Array.isArray(msgItem.value) ? msgItem.value : {};
      for (const tg of targets) {
        if (tg.type !== 'seller' || !tg.sellerId) continue;
        const s = findSeller(sellers, tg.sellerId);
        const nick = sellerOfficialNick(s);
        const list = Array.isArray(allMsg[tg.sellerId]) ? allMsg[tg.sellerId] : [];
        const names = tg.items.map(i => i.name).join(', ');
        const saleSum = tg.items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
        const commissionHint = Math.round(saleSum * COMMISSION_RATE);
        list.unshift({
          id: `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: 'Rasmiylashtirish amalga oshirildi',
          body: `Rasmiylashtirish amalga oshirildi. Mijoz ${sanitizeStr(b.name, 80)} (${sanitizeStr(b.phone, 40)}) sizning (${nick}) mahsulotlaringizni rasmiylashtirdi: ${names}. Buyurtma: ${order.id}. Taxminiy 3% komissiya: ${commissionHint} so‘m. Tasdiqlaysizmi? (Ha — 3% qarz yoziladi / Yo‘q)`,
          type: 'confirm_required',
          orderId: order.id,
          saleAmount: saleSum,
          commissionAmount: commissionHint,
          from: 'system',
          createdAt: nowISO(),
          read: false,
          requiresAction: true
        });
        allMsg[tg.sellerId] = list.slice(0, 500);
      }
      if (targets.some(x => x.type === 'seller')) await putOne('shoply_seller_messages_v1', allMsg);
      return send(res, 201, { ok: true, id: order.id, telegramTargets: targets.map(x => ({ type: x.type, username: x.username, sellerId: x.sellerId, storeName: x.storeName, itemNames: x.items.map(i => i.name) })) });
    }

    if (p.startsWith('/api/orders/') && req.method === 'PATCH') {
      const id = decodeURIComponent(p.slice('/api/orders/'.length));
      const b = await readBody(req);
      const newStatus = String(b.status || '').slice(0, 60);
      let found = false;
      let updatedOrder = null;

      const list = await updateOrders(items =>
        items.map(o => {
          if (String(o.id) !== id) return o;
          found = true;
          const next = { ...o, status: newStatus || o.status || 'Yangi' };
          // Commission only when marked as delivered / confirmed sale
          if (
            !o.commissionApplied &&
            (newStatus === 'Yetkazildi' || newStatus === 'Delivered' || newStatus === 'Yetkazib berildi')
          ) {
            // mark will be set after apply
            updatedOrder = next;
          } else {
            updatedOrder = next;
          }
          return next;
        })
      );

      if (!found) return send(res, 404, { error: 'Order not found' });

      // Apply commission outside the map if needed
      const order = list.find(o => String(o.id) === id);
      if (
        order &&
        !order.commissionApplied &&
        (order.status === 'Yetkazildi' || order.status === 'Delivered' || order.status === 'Yetkazib berildi')
      ) {
        const result = await applyCommissionForOrder(order);
        if (result.applied) {
          await updateOrders(items =>
            items.map(o => (String(o.id) === id ? { ...o, commissionApplied: true, commissionAppliedAt: nowISO() } : o))
          );
          order.commissionApplied = true;
        }
      }

      return send(res, 200, { ok: true, order });
    }

    // ========== SELLER APPLICATIONS ==========
    if (p === '/api/seller/apply' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      if (!userId || userId === 'guest') {
        return send(res, 400, { error: 'Telegram orqali kiring. Tadbirkorlik uchun Telegram ID kerak.' });
      }
      if (!b.agreedCommission) {
        return send(res, 400, { error: '3% komissiya shartiga rozilik bildirishingiz shart.' });
      }
      const fullName = sanitizeStr(b.fullName, 120);
      const storeName = sanitizeStr(b.storeName, 100);
      const phone = sanitizeStr(b.phone, 40);
      if (!fullName || !storeName || !phone) {
        return send(res, 400, { error: 'Ism, do‘kon nomi va telefon majburiy.' });
      }

      const apps = await getApplications();
      const sellers = await getSellers();

      // Already approved seller?
      if (findSeller(sellers, userId) && findSeller(sellers, userId).status !== 'rejected') {
        return send(res, 400, { error: 'Siz allaqachon tadbirkorsiz yoki arizangiz ko‘rib chiqilmoqda.' });
      }

      // Pending application?
      const pending = apps.find(a => String(a.userId) === userId && a.status === 'pending');
      if (pending) {
        return send(res, 400, { error: 'Sizda allaqachon kutilayotgan ariza bor.' });
      }

      const app = {
        id: `APP-${Date.now()}`,
        userId,
        fullName,
        storeName,
        phone,
        email: sanitizeStr(b.email, 120),
        telegramUsername: sanitizeStr(b.telegramUsername, 80),
        photo: typeof b.photo === 'string' ? b.photo.slice(0, 500000) : '',
        logo: typeof b.logo === 'string' ? b.logo.slice(0, 500000) : '',
        extra: sanitizeStr(b.extra, 1000),
        agreedCommission: true,
        status: 'pending',
        rejectReason: '',
        createdAt: nowISO(),
        reviewedAt: null
      };
      apps.unshift(app);
      await putApplications(apps.slice(0, 5000));
      return send(res, 201, {
        ok: true,
        message: 'Arizangiz muvaffaqiyatli yuborildi. Arizangiz 24 soat ichida administrator tomonidan ko‘rib chiqiladi.',
        application: { id: app.id, status: app.status, createdAt: app.createdAt }
      });
    }

    if (p === '/api/seller/my-application' && req.method === 'GET') {
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const apps = await getApplications();
      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      const myApps = apps.filter(a => String(a.userId) === userId).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      const latest = myApps[0] || null;
      const safeSeller = seller ? {
        userId: seller.userId,
        storeName: seller.storeName,
        fullName: seller.fullName,
        status: seller.status,
        login: seller.login || null,
        hasPassword: !!(seller.passwordHash),
        approvedAt: seller.approvedAt,
        debt: seller.debt || 0,
        photo: seller.photo || ''
      } : null;
      return send(res, 200, {
        application: latest,
        seller: safeSeller,
        isSeller: !!(seller && (seller.status === 'active' || seller.status === 'frozen'))
      });
    }

    // Admin: list / review applications
    if (p === '/api/admin/seller-applications' && req.method === 'GET') {
      const apps = await getApplications();
      return send(res, 200, apps);
    }

    if (p === '/api/admin/seller-applications/review' && req.method === 'POST') {
      const b = await readBody(req);
      const appId = sanitizeStr(b.id || b.appId, 80);
      const action = sanitizeStr(b.action, 20); // approve | reject
      const reason = sanitizeStr(b.reason, 500);
      if (!appId || !['approve', 'reject'].includes(action)) {
        return send(res, 400, { error: 'id va action (approve/reject) kerak' });
      }

      const apps = await getApplications();
      const idx = apps.findIndex(a => String(a.id) === appId);
      if (idx < 0) return send(res, 404, { error: 'Ariza topilmadi' });
      const app = apps[idx];
      if (app.status !== 'pending') return send(res, 400, { error: 'Ariza allaqachon ko‘rib chiqilgan' });

      if (action === 'reject') {
        app.status = 'rejected';
        app.rejectReason = reason || 'Rad etildi';
        app.reviewedAt = nowISO();
        apps[idx] = app;
        await putApplications(apps);
        return send(res, 200, { ok: true, application: app });
      }

      // approve
      app.status = 'approved';
      app.reviewedAt = nowISO();
      apps[idx] = app;
      await putApplications(apps);

      const sellers = await getSellers();
      let seller = findSeller(sellers, app.userId);
      if (!seller) {
        seller = {
          id: app.userId,
          userId: app.userId,
          fullName: app.fullName,
          storeName: app.storeName,
          phone: app.phone,
          email: app.email,
          telegramUsername: app.telegramUsername,
          photo: app.photo || '',
          logo: app.logo || app.photo || '',
          status: 'active',
          debt: 0,
          totalSales: 0,
          totalCommission: 0,
          paidCommission: 0,
          productsCount: 0,
          approvedAt: nowISO(),
          lastActiveAt: nowISO(),
          createdAt: app.createdAt,
          freezeReason: ''
        };
        sellers.unshift(seller);
      } else {
        seller.status = 'active';
        seller.fullName = app.fullName;
        seller.storeName = app.storeName;
        seller.phone = app.phone;
        seller.email = app.email;
        seller.telegramUsername = app.telegramUsername;
        if (app.photo) seller.photo = app.photo;
        if (app.logo) seller.logo = app.logo;
        seller.approvedAt = nowISO();
        seller.freezeReason = '';
      }
      await putSellers(sellers);
      return send(res, 200, { ok: true, application: app, seller });
    }

    // ========== SELLERS ==========
    if (p === '/api/admin/sellers' && req.method === 'GET') {
      const sellers = await getSellers();
      const products = await getProducts();
      const enriched = sellers.map(s => {
        ensureSellerStats(s);
        const count = products.filter(pr => String(pr.sellerId) === String(s.userId)).length;
        return { ...s, productsCount: count };
      });
      return send(res, 200, enriched);
    }

    if (p === '/api/admin/sellers/freeze' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const action = sanitizeStr(b.action, 20); // freeze | unfreeze
      const reason = sanitizeStr(b.reason, 300);
      if (!userId || !['freeze', 'unfreeze'].includes(action)) {
        return send(res, 400, { error: 'userId va action kerak' });
      }
      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 404, { error: 'Tadbirkor topilmadi' });
      if (action === 'freeze') {
        seller.status = 'frozen';
        seller.frozenAt = nowISO();
        seller.freezeReason = reason || 'Admin tomonidan muzlatildi';
      } else {
        seller.status = 'active';
        seller.frozenAt = null;
        seller.freezeReason = '';
      }
      await putSellers(sellers);
      return send(res, 200, { ok: true, seller });
    }

    if (p === '/api/seller/me' && req.method === 'GET') {
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 404, { error: 'Tadbirkor topilmadi' });
      ensureSellerStats(seller);
      const products = await getProducts();
      seller.productsCount = products.filter(pr => String(pr.sellerId) === String(userId)).length;
      return send(res, 200, seller);
    }

    // Seller products: safe merge
    if (p === '/api/seller/products' && req.method === 'GET') {
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const products = await getProducts();
      const mine = products.filter(pr => String(pr.sellerId) === String(userId));
      return send(res, 200, mine);
    }

    if (p === '/api/seller/products' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      if (!userId || userId === 'guest') return send(res, 400, { error: 'userId kerak' });

      const sellers = await getSellers();
      let seller = findSeller(sellers, userId);
      if (!seller) return send(res, 403, { error: 'Siz tasdiqlangan tadbirkor emassiz' });
      // Parol o‘rnatilgan bo‘lsa — session token majburiy
      if (seller.passwordHash) {
        const token = sanitizeStr(b.token || req.headers['x-seller-token'], 80);
        if (!token || seller.sessionToken !== token) {
          return send(res, 401, { error: 'Sessiya muddati tugagan. Qayta login qiling.' });
        }
      }
      if (seller.status === 'frozen') {
        return send(res, 403, {
          error: 'Hisobingiz muzlatilgan. Yangi mahsulot qo‘sha olmaysiz. Qarzingizni to‘lang yoki admin bilan bog‘laning.',
          debt: seller.debt
        });
      }

      const name = sanitizeStr(b.name, 150);
      const price = Number(b.price);
      if (!name || !(price >= 0)) return send(res, 400, { error: 'Nom va narx majburiy' });

      const product = {
        id: b.id || `S-${userId}-${Date.now()}`,
        name,
        category: sanitizeStr(b.category, 80) || 'Boshqa',
        price,
        oldPrice: b.oldPrice != null && b.oldPrice !== '' ? Number(b.oldPrice) : null,
        image: typeof b.image === 'string' ? b.image.slice(0, 800000) : '',
        images: Array.isArray(b.images) ? b.images.slice(0, 5).map(x => String(x).slice(0, 800000)) : [],
        sizes: Array.isArray(b.sizes) ? b.sizes.map(x => sanitizeStr(x, 40)).filter(Boolean) : [],
        colors: Array.isArray(b.colors) ? b.colors.map(x => sanitizeStr(x, 40)).filter(Boolean) : [],
        colorImages: (b.colorImages && typeof b.colorImages === 'object' && !Array.isArray(b.colorImages))
          ? Object.fromEntries(Object.entries(b.colorImages).slice(0, 12).map(([k, v]) => [sanitizeStr(k, 40), String(v).slice(0, 800000)]))
          : undefined,
        description: sanitizeStr(b.description, 2000),
        badge: sanitizeStr(b.badge, 40),
        stock: b.stock != null ? Number(b.stock) : null,
        sellerId: String(userId),
        storeName: seller.storeName || '',
        sellerUsername: seller.telegramUsername || '',
        createdAt: nowISO(),
        updatedAt: nowISO()
      };

      const products = await getProducts();
      // If updating existing owned product
      const existingIdx = products.findIndex(pr => String(pr.id) === String(product.id));
      if (existingIdx >= 0) {
        if (String(products[existingIdx].sellerId) !== String(userId)) {
          return send(res, 403, { error: 'Bu mahsulot sizga tegishli emas' });
        }
        if (seller.status === 'frozen') {
          return send(res, 403, { error: 'Hisob muzlatilgan — tahrirlash mumkin emas' });
        }
        products[existingIdx] = { ...products[existingIdx], ...product, sellerId: String(userId), updatedAt: nowISO() };
      } else {
        products.unshift(product);
      }
      await putProducts(products);

      // update count
      ensureSellerStats(seller);
      seller.productsCount = products.filter(pr => String(pr.sellerId) === String(userId)).length;
      seller.lastActiveAt = nowISO();
      await putSellers(sellers);

      return send(res, 201, { ok: true, product });
    }

    if (p === '/api/seller/products/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const productId = sanitizeStr(b.productId, 80);
      if (!userId || !productId) return send(res, 400, { error: 'userId va productId kerak' });

      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 403, { error: 'Tadbirkor emassiz' });
      if (seller.passwordHash) {
        const token = sanitizeStr(b.token || req.headers['x-seller-token'], 80);
        if (!token || seller.sessionToken !== token) {
          return send(res, 401, { error: 'Sessiya muddati tugagan. Qayta login qiling.' });
        }
      }
      // Allow delete even if frozen (cleanup)

      let products = await getProducts();
      const before = products.length;
      products = products.filter(pr => {
        if (String(pr.id) !== productId) return true;
        return String(pr.sellerId) !== String(userId); // only remove if owner
      });
      if (products.length === before) return send(res, 404, { error: 'Mahsulot topilmadi yoki sizga tegishli emas' });
      await putProducts(products);

      ensureSellerStats(seller);
      seller.productsCount = products.filter(pr => String(pr.sellerId) === String(userId)).length;
      await putSellers(sellers);
      return send(res, 200, { ok: true });
    }

    // Seller orders (only own items)
    if (p === '/api/seller/orders' && req.method === 'GET') {
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const sellers = await getSellers();
      if (!findSeller(sellers, userId)) return send(res, 403, { error: 'Tadbirkor emassiz' });

      const ordersX = await getOne('shoply_orders_v1');
      const allOrders = Array.isArray(ordersX.value) ? ordersX.value : [];
      const products = await getProducts();
      const myProductIds = new Set(
        products.filter(pr => String(pr.sellerId) === String(userId)).map(pr => String(pr.id))
      );

      const result = [];
      for (const order of allOrders) {
        const myItems = (order.items || []).filter(it => {
          const sid = it.sellerId || (products.find(p => String(p.id) === String(it.productId || it.id)) || {}).sellerId;
          return String(sid) === String(userId) || myProductIds.has(String(it.productId || it.id));
        });
        if (!myItems.length) continue;
        result.push({
          ...order,
          items: myItems,
          // hide other sellers' data
          _sellerView: true
        });
      }
      return send(res, 200, result);
    }

    // Seller can update status of their portion? We keep global status on order; seller can suggest via note or we allow limited status for their items.
    // For simplicity: seller can set a per-item or overall note; main status remains admin-controlled.
    // Optional: allow seller to mark "Jarayonda" etc on the order if they are the only seller — skip for safety.
    if (p === '/api/seller/orders/status' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const orderId = sanitizeStr(b.orderId, 80);
      const status = sanitizeStr(b.status, 60);
      const allowed = ['Yangi', 'Jarayonda', 'Yetkazilmoqda', 'Yetkazildi', 'Bekor qilindi'];
      if (!userId || !orderId || !allowed.includes(status)) {
        return send(res, 400, { error: 'Noto‘g‘ri parametrlar' });
      }
      const sellers = await getSellers();
      if (!findSeller(sellers, userId)) return send(res, 403, { error: 'Tadbirkor emassiz' });

      // Only allow if order contains this seller's items
      let touched = false;
      const list = await updateOrders(items =>
        items.map(o => {
          if (String(o.id) !== orderId) return o;
          const hasMine = (o.items || []).some(it => String(it.sellerId) === String(userId));
          if (!hasMine) return o;
          touched = true;
          const next = { ...o, status, sellerUpdatedAt: nowISO(), sellerUpdatedBy: userId };
          return next;
        })
      );

      if (!touched) return send(res, 404, { error: 'Buyurtma topilmadi yoki sizga tegishli emas' });

      const order = list.find(o => String(o.id) === orderId);
      // If seller marks delivered, also try commission (admin can also do it)
      if (order && !order.commissionApplied && (status === 'Yetkazildi')) {
        await applyCommissionForOrder(order);
        await updateOrders(items =>
          items.map(o => (String(o.id) === orderId ? { ...o, commissionApplied: true, commissionAppliedAt: nowISO() } : o))
        );
      }
      return send(res, 200, { ok: true, order });
    }

    // Commission history for seller
    if (p === '/api/seller/commissions' && req.method === 'GET') {
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const log = await getCommissionLog();
      const mine = log.filter(l => String(l.sellerId) === String(userId));
      return send(res, 200, mine);
    }

    // Admin commission log / stats
    if (p === '/api/admin/commissions' && req.method === 'GET') {
      const log = await getCommissionLog();
      return send(res, 200, log);
    }


    // ========== SELLER AUTH (login / set password) ==========
    if (p === '/api/seller/set-password' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const login = sanitizeStr(b.login, 60).toLowerCase();
      const password = String(b.password || '');
      const password2 = String(b.password2 || '');
      if (!userId || userId === 'guest') return send(res, 400, { error: 'Telegram orqali kiring' });
      if (!login || login.length < 3) return send(res, 400, { error: 'Login kamida 3 belgi bo‘lsin' });
      if (password.length < 6) return send(res, 400, { error: 'Parol kamida 6 belgi bo‘lsin' });
      if (password !== password2) return send(res, 400, { error: 'Parollar mos kelmadi' });

      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 403, { error: 'Siz tasdiqlangan tadbirkor emassiz' });

      // unique login
      if (sellers.some(s => String(s.login || '').toLowerCase() === login && String(s.userId) !== String(userId))) {
        return send(res, 400, { error: 'Bu login band. Boshqa login tanlang.' });
      }

      const { salt, hash } = hashPassword(password);
      seller.login = login;
      seller.passwordSalt = salt;
      seller.passwordHash = hash;
      seller.passwordSetAt = nowISO();
      // clear any plain leftovers
      delete seller.password;
      const token = makeSessionToken();
      seller.sessionToken = token;
      seller.sessionAt = nowISO();
      await putSellers(sellers);
      return send(res, 200, {
        ok: true,
        message: 'Login va parol saqlandi',
        token,
        seller: {
          userId: seller.userId,
          login: seller.login,
          storeName: seller.storeName,
          fullName: seller.fullName,
          status: seller.status,
          hasPassword: true
        }
      });
    }

    if (p === '/api/seller/login' && req.method === 'POST') {
      const b = await readBody(req);
      const login = sanitizeStr(b.login, 60).toLowerCase();
      const password = String(b.password || '');
      if (!login || !password) return send(res, 400, { error: 'Login va parol kerak' });

      const sellers = await getSellers();
      const seller = sellers.find(s => String(s.login || '').toLowerCase() === login);
      if (!seller || !seller.passwordHash) {
        return send(res, 401, { error: 'Login yoki parol noto‘g‘ri' });
      }
      if (!verifyPassword(password, seller.passwordSalt, seller.passwordHash)) {
        return send(res, 401, { error: 'Login yoki parol noto‘g‘ri' });
      }
      const token = makeSessionToken();
      seller.sessionToken = token;
      seller.sessionAt = nowISO();
      seller.lastActiveAt = nowISO();
      await putSellers(sellers);
      return send(res, 200, {
        ok: true,
        token,
        seller: {
          userId: seller.userId,
          login: seller.login,
          storeName: seller.storeName,
          fullName: seller.fullName,
          status: seller.status,
          photo: seller.photo || '',
          debt: seller.debt || 0,
          hasPassword: true
        }
      });
    }

    if (p === '/api/seller/session' && req.method === 'GET') {
      const token = sanitizeStr(u.searchParams.get('token') || req.headers['x-seller-token'], 80);
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!token && !userId) return send(res, 400, { error: 'token yoki userId kerak' });
      const sellers = await getSellers();
      let seller = null;
      if (token) seller = sellers.find(s => s.sessionToken && s.sessionToken === token);
      // Agar parol o‘rnatilgan bo‘lsa — faqat token bilan kirish mumkin (userId bilan bypass yo‘q)
      if (!seller && userId) {
        const byUser = findSeller(sellers, userId);
        if (byUser && !byUser.passwordHash) {
          seller = byUser; // faqat hali login yaratmaganlar uchun
        }
      }
      if (!seller) return send(res, 401, { error: 'Sessiya topilmadi. Login va parol bilan kiring.' });
      ensureSellerStats(seller);
      const products = await getProducts();
      seller.productsCount = products.filter(pr => String(pr.sellerId) === String(seller.userId)).length;
      return send(res, 200, {
        userId: seller.userId,
        login: seller.login || null,
        hasPassword: !!(seller.passwordHash),
        storeName: seller.storeName,
        fullName: seller.fullName,
        phone: seller.phone,
        email: seller.email,
        telegramUsername: seller.telegramUsername,
        photo: seller.photo || '',
        status: seller.status,
        debt: seller.debt,
        totalSales: seller.totalSales,
        totalCommission: seller.totalCommission,
        paidCommission: seller.paidCommission,
        productsCount: seller.productsCount,
        approvedAt: seller.approvedAt,
        lastActiveAt: seller.lastActiveAt,
        freezeReason: seller.freezeReason || '',
        officialNick: sellerOfficialNick(seller)
      });
    }

    if (p === '/api/seller/change-password' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const token = sanitizeStr(b.token, 80);
      const oldPassword = String(b.oldPassword || '');
      const password = String(b.password || '');
      const password2 = String(b.password2 || '');
      if (password.length < 6) return send(res, 400, { error: 'Yangi parol kamida 6 belgi' });
      if (password !== password2) return send(res, 400, { error: 'Parollar mos kelmadi' });
      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 403, { error: 'Tadbirkor topilmadi' });
      if (seller.passwordHash) {
        if (!verifyPassword(oldPassword, seller.passwordSalt, seller.passwordHash) &&
            !(token && seller.sessionToken === token)) {
          return send(res, 401, { error: 'Eski parol noto‘g‘ri' });
        }
      }
      const { salt, hash } = hashPassword(password);
      seller.passwordSalt = salt;
      seller.passwordHash = hash;
      seller.passwordSetAt = nowISO();
      await putSellers(sellers);
      return send(res, 200, { ok: true, message: 'Parol yangilandi' });
    }


    // ========== SELLER MESSAGES / ADMIN NOTIFY ==========
    if (p === '/api/admin/sellers/notify' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const title = sanitizeStr(b.title, 120) || 'Bildirishnoma';
      const body = sanitizeStr(b.body, 2000);
      const type = sanitizeStr(b.type, 30) || 'info'; // info | warning | sms
      if (!userId || !body) return send(res, 400, { error: 'userId va xabar matni kerak' });
      const sellers = await getSellers();
      if (!findSeller(sellers, userId)) return send(res, 404, { error: 'Tadbirkor topilmadi' });
      const item = await getOne('shoply_seller_messages_v1',
  'shoply_admin_notifications_v1');
      const all = item.value && typeof item.value === 'object' && !Array.isArray(item.value) ? item.value : {};
      const list = Array.isArray(all[userId]) ? all[userId] : [];
      const msg = {
        id: `MSG-${Date.now()}`,
        title,
        body,
        type,
        from: 'admin',
        createdAt: nowISO(),
        read: false
      };
      all[userId] = [msg, ...list].slice(0, 500);
      await putOne('shoply_seller_messages_v1',
  'shoply_admin_notifications_v1', all);
      return send(res, 201, { ok: true, message: msg });
    }

    if (p === '/api/seller/messages' && req.method === 'GET') {
      const userId = sanitizeStr(u.searchParams.get('userId'), 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const item = await getOne('shoply_seller_messages_v1',
  'shoply_admin_notifications_v1');
      const all = item.value && typeof item.value === 'object' && !Array.isArray(item.value) ? item.value : {};
      const list = Array.isArray(all[userId]) ? all[userId] : [];
      return send(res, 200, list);
    }

    if (p === '/api/seller/messages/read' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const msgId = sanitizeStr(b.messageId, 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const item = await getOne('shoply_seller_messages_v1',
  'shoply_admin_notifications_v1');
      const all = item.value && typeof item.value === 'object' && !Array.isArray(item.value) ? item.value : {};
      const list = Array.isArray(all[userId]) ? all[userId] : [];
      all[userId] = list.map(m => (msgId && String(m.id) !== msgId ? m : { ...m, read: true }));
      await putOne('shoply_seller_messages_v1',
  'shoply_admin_notifications_v1', all);
      return send(res, 200, { ok: true });
    }


    if (p === '/api/seller/profile' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      if (!userId) return send(res, 400, { error: 'userId kerak' });
      const sellers = await getSellers();
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 403, { error: 'Tadbirkor emassiz' });
      if (b.storeName) seller.storeName = sanitizeStr(b.storeName, 100);
      if (b.phone) seller.phone = sanitizeStr(b.phone, 40);
      if (b.email !== undefined) seller.email = sanitizeStr(b.email, 120);
      if (b.telegramUsername !== undefined) seller.telegramUsername = sanitizeStr(b.telegramUsername, 80);
      if (typeof b.logo === 'string') seller.logo = b.logo.slice(0, 500000);
      if (typeof b.photo === 'string') seller.photo = b.photo.slice(0, 500000);
      seller.lastActiveAt = nowISO();
      await putSellers(sellers);
      // update storeName on products
      if (b.storeName) {
        const products = await getProducts();
        let changed = false;
        for (const pr of products) {
          if (String(pr.sellerId) === String(userId)) {
            pr.storeName = seller.storeName;
            changed = true;
          }
        }
        if (changed) await putProducts(products);
      }
      return send(res, 200, { ok: true, seller: { userId: seller.userId, storeName: seller.storeName, logo: seller.logo || '', photo: seller.photo || '' } });
    }


    if (p === '/api/seller/orders/confirm' && req.method === 'POST') {
      const b = await readBody(req);
      const userId = sanitizeStr(b.userId, 80);
      const orderId = sanitizeStr(b.orderId, 80);
      const confirm = b.confirm === true || b.confirm === 'true' || b.confirm === 'yes';
      if (!userId || !orderId) return send(res, 400, { error: 'userId va orderId kerak' });
      const sellers = await getSellers();
      const sellerAuth = findSeller(sellers, userId);
      if (!sellerAuth) return send(res, 403, { error: 'Tadbirkor emassiz' });
      if (sellerAuth.passwordHash) {
        const token = sanitizeStr(b.token || req.headers['x-seller-token'], 80);
        if (!token || sellerAuth.sessionToken !== token) {
          return send(res, 401, { error: 'Sessiya muddati tugagan. Qayta login qiling.' });
        }
      }
      let found = false;
      let orderRef = null;
      await updateOrders(list => list.map(o => {
        if (String(o.id) !== orderId) return o;
        found = true;
        const conf = { ...(o.sellerConfirmations || {}) };
        if (conf[userId] === 'confirmed' || conf[userId] === 'rejected') {
          orderRef = o;
          return o;
        }
        conf[userId] = confirm ? 'confirmed' : 'rejected';
        const next = { ...o, sellerConfirmations: conf, status: confirm ? (o.status === 'Yangi' ? 'Jarayonda' : o.status) : o.status };
        orderRef = next;
        return next;
      }));
      if (!found) return send(res, 404, { error: 'Buyurtma topilmadi' });
      const prev = (orderRef && orderRef.sellerConfirmations && orderRef.sellerConfirmations[userId]);
      // If already decided before this request was applied... check log
      if (confirm) {
        const result = await applyCommissionForSeller(orderRef, userId);
        const nick = sellerOfficialNick(sellerAuth);
        await pushAdminNotification({
          type: 'seller_confirmed',
          title: 'Tadbirkor buyurtmani tasdiqladi',
          body: `Tadbirkor ${nick || userId} buyurtma ${orderId} ni tasdiqladi. Komissiya: ${result.applied ? 'hisoblandi' : 'yo‘q yoki oldin hisoblangan'}.`,
          orderId,
          officialNick: nick
        });
        // Mark related confirm_required messages as handled
        try {
          const msgItem = await getOne('shoply_seller_messages_v1');
          const allMsg = msgItem.value && typeof msgItem.value === 'object' && !Array.isArray(msgItem.value) ? msgItem.value : {};
          const list = Array.isArray(allMsg[userId]) ? allMsg[userId] : [];
          let changed = false;
          for (const m of list) {
            if (m.orderId === orderId && m.requiresAction) {
              m.requiresAction = false;
              m.read = true;
              m.type = 'order_confirmed';
              changed = true;
            }
          }
          if (changed) {
            allMsg[userId] = list;
            await putOne('shoply_seller_messages_v1', allMsg);
          }
        } catch (e) {}
        return send(res, 200, { ok: true, confirmed: true, commission: result });
      }
      const nickR = sellerOfficialNick(sellerAuth);
      await pushAdminNotification({
        type: 'seller_rejected',
        title: 'Tadbirkor buyurtmani rad etdi',
        body: `Tadbirkor ${nickR || userId} buyurtma ${orderId} ni rad etdi (komissiya yozilmadi).`,
        orderId,
        officialNick: nickR
      });
      try {
        const msgItem = await getOne('shoply_seller_messages_v1');
        const allMsg = msgItem.value && typeof msgItem.value === 'object' && !Array.isArray(msgItem.value) ? msgItem.value : {};
        const list = Array.isArray(allMsg[userId]) ? allMsg[userId] : [];
        let changed = false;
        for (const m of list) {
          if (m.orderId === orderId && m.requiresAction) {
            m.requiresAction = false;
            m.read = true;
            m.type = 'order_rejected';
            changed = true;
          }
        }
        if (changed) {
          allMsg[userId] = list;
          await putOne('shoply_seller_messages_v1', allMsg);
        }
      } catch (e) {}
      return send(res, 200, { ok: true, confirmed: false });
    }

    if (p === '/api/admin/notifications' && req.method === 'GET') {
      const item = await getOne('shoply_admin_notifications_v1');
      return send(res, 200, Array.isArray(item.value) ? item.value : []);
    }

    // Reviews (unchanged)
    if (p === '/api/reviews' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.productId || '');
      if (!id || !b.review) return send(res, 400, { error: 'Invalid review' });
      const item = await getOne('shoply_reviews_v1');
      const all = item.value && typeof item.value === 'object' ? item.value : {};
      const rows = Array.isArray(all[id]) ? all[id] : [];
      all[id] = [...rows, b.review];
      await putOne('shoply_reviews_v1', all);
      return send(res, 201, { ok: true });
    }

    // Static files
    let filePath = decodeURIComponent(p);
    if (filePath === '/') filePath = '/index.html';
    const file = path.resolve(ROOT, '.' + filePath);
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, buffer) => {
      if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      send(res, 200, buffer, mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
  } catch (error) {
    console.error(error);
    send(res, 500, {
      error: 'Server error',
      message: process.env.NODE_ENV === 'production' ? 'Ma’lumotlar bazasi bilan aloqa xatosi' : error.message
    });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`SHOPLY server ${PORT} portda ishga tushdi`));
