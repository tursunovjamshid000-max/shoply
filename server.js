'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'shoply_data';
const ROOT = __dirname;
const COMMISSION_RATE = 0.03;
const FREEZE_THRESHOLD = 30000;

const ALLOWED = new Set([
  'mono_store_products_v2', 'mono_store_settings_v2', 'mono_store_slides_v2',
  'mono_store_cart_events_v1', 'shoply_orders_v1', 'shoply_reviews_v1',
  'mono_store_admin_profile_v1', 'shoply_site_builder_v1', 'shoply_promo_codes_v1',
  // Seller marketplace keys
  'shoply_seller_applications_v1',
  'shoply_sellers_v1',
  'shoply_commission_log_v1'
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
  const x = await getOne('shoply_commission_log_v1');
  return Array.isArray(x.value) ? x.value : [];
}

async function putCommissionLog(list) {
  await putOne('shoply_commission_log_v1', list);
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
      return send(res, 200, await getAll());
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
      const order = {
        ...b,
        items,
        id: b.id || `ORD-${Date.now()}`,
        createdAt: b.createdAt || nowISO(),
        status: b.status || 'Yangi',
        commissionApplied: false
      };
      await updateOrders(list => [order, ...list].slice(0, 10000));
      return send(res, 201, { ok: true, id: order.id });
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
      return send(res, 200, {
        application: latest,
        seller: seller || null,
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
      const seller = findSeller(sellers, userId);
      if (!seller) return send(res, 403, { error: 'Siz tasdiqlangan tadbirkor emassiz' });
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
