// SHOPLY backend — Supabase persistent storage for Render
// Required environment variables:
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_TOKEN_SECRET

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || '';

const PUBLIC_KEYS = new Set([
  'mono_store_products_v2',
  'mono_store_settings_v2',
  'mono_store_slides_v2',
  'shoply_reviews_v1'
]);

const ADMIN_KEYS = new Set([
  ...PUBLIC_KEYS,
  'mono_store_cart_events_v1',
  'shoply_orders_v1'
]);

const MIME = {
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

  res.end(
    type.startsWith('application/json')
      ? JSON.stringify(data)
      : data
  );
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let done = false;

    req.on('data', chunk => {
      if (done) return;

      raw += chunk;

      if (Buffer.byteLength(raw) > limit) {
        done = true;
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (done) return;

      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function needConfig() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase environment variables are missing');
  }
}

async function dbRequest(endpoint, options = {}) {
  needConfig();

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${endpoint}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error(
      'Supabase error:',
      response.status,
      text.slice(0, 1000)
    );

    throw new Error(`Database request failed (${response.status})`);
  }

  return text ? JSON.parse(text) : null;
}

async function getValue(key, fallback) {
  const rows = await dbRequest(
    `shoply_data?key=eq.${encodeURIComponent(key)}&select=value&limit=1`
  );

  return rows && rows.length
    ? rows[0].value
    : fallback;
}

async function setValue(key, value) {
  await dbRequest('shoply_data?on_conflict=key', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      key,
      value,
      updated_at: new Date().toISOString()
    })
  });
}

async function deleteValue(key) {
  await dbRequest(
    `shoply_data?key=eq.${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
      headers: {
        Prefer: 'return=minimal'
      }
    }
  );
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function makeToken(username) {
  const payload = b64url(JSON.stringify({
    sub: username,
    iat: Date.now(),
    exp: Date.now() + 12 * 60 * 60 * 1000
  }));

  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

function verifyToken(req) {
  if (!TOKEN_SECRET) return false;

  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : '';

  const parts = token.split('.');

  if (parts.length !== 2) return false;

  const expected = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(parts[0])
    .digest();

  let actual;

  try {
    actual = Buffer.from(parts[1], 'base64url');
  } catch {
    return false;
  }

  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString()
    );

    return (
      payload.sub === ADMIN_USERNAME &&
      Number(payload.exp) > Date.now()
    );
  } catch {
    return false;
  }
}

function adminOnly(req, res) {
  if (!verifyToken(req)) {
    send(res, 401, {
      error: 'Admin login required'
    });

    return false;
  }

  return true;
}

function safeKey(key, set) {
  return set.has(key);
}

function cleanText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // HEALTH CHECK
  if (
    pathname === '/api/health' &&
    req.method === 'GET'
  ) {
    try {
      await dbRequest('shoply_data?select=key&limit=1');

      return send(res, 200, {
        ok: true,
        service: 'SHOPLY Supabase API',
        database: 'connected'
      });
    } catch (error) {
      return send(res, 503, {
        ok: false,
        service: 'SHOPLY Supabase API',
        database: 'disconnected',
        error: error.message
      });
    }
  }

  // ADMIN LOGIN
  if (
    pathname === '/api/admin/login' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_USERNAME ||
      !ADMIN_PASSWORD ||
      !TOKEN_SECRET
    ) {
      return send(res, 503, {
        error: 'Admin login environment variables are not configured'
      });
    }

    const body = await readBody(req, 16 * 1024);

    const user = cleanText(body.username, 100);
    const pass = String(body.password || '');

    const digest = value =>
      crypto.createHash('sha256')
        .update(String(value))
        .digest();

    const userOK = crypto.timingSafeEqual(
      digest(user),
      digest(ADMIN_USERNAME)
    );

    const passOK = crypto.timingSafeEqual(
      digest(pass),
      digest(ADMIN_PASSWORD)
    );

    if (!userOK || !passOK) {
      return send(res, 401, {
        error: 'Login yoki parol noto‘g‘ri'
      });
    }

    return send(res, 200, {
      ok: true,
      token: makeToken(user)
    });
  }

  // CHECK ADMIN SESSION
  if (
    pathname === '/api/admin/me' &&
    req.method === 'GET'
  ) {
    if (!adminOnly(req, res)) return;

    return send(res, 200, {
      ok: true,
      username: ADMIN_USERNAME
    });
  }

  // PUBLIC STORE DATA
  if (
    pathname === '/api/state' &&
    req.method === 'GET'
  ) {
    try {
      const result = {};

      for (const key of PUBLIC_KEYS) {
        result[key] = await getValue(
          key,
          key === 'mono_store_settings_v2'
            ? {}
            : key === 'shoply_reviews_v1'
              ? {}
              : []
        );
      }

      return send(res, 200, result);
    } catch (error) {
      return send(res, 503, {
        error: 'Ma’lumotlar bazasiga ulanib bo‘lmadi'
      });
    }
  }

  // ADMIN STORE DATA
  if (
    pathname === '/api/admin/state' &&
    req.method === 'GET'
  ) {
    if (!adminOnly(req, res)) return;

    try {
      const result = {};

      for (const key of ADMIN_KEYS) {
        result[key] = await getValue(
          key,
          key === 'mono_store_settings_v2'
            ? {}
            : key === 'shoply_reviews_v1'
              ? {}
              : []
        );
      }

      return send(res, 200, result);
    } catch (error) {
      return send(res, 503, {
        error: 'Ma’lumotlar bazasiga ulanib bo‘lmadi'
      });
    }
  }

  // SAVE / DELETE ADMIN DATA
  if (pathname.startsWith('/api/state/')) {
    if (!adminOnly(req, res)) return;

    const key = pathname.slice('/api/state/'.length);

    if (!safeKey(key, ADMIN_KEYS)) {
      return send(res, 400, {
        error: 'Unknown state key'
      });
    }

    try {
      if (req.method === 'GET') {
        const value = await getValue(key, null);

        if (value === null) {
          return send(res, 404, {
            error: 'Not found'
          });
        }

        return send(res, 200, {
          key,
          value
        });
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);

        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
          return send(res, 400, {
            error: 'value is required'
          });
        }

        await setValue(key, body.value);

        return send(res, 200, {
          ok: true,
          key
        });
      }

      if (req.method === 'DELETE') {
        await deleteValue(key);

        return send(res, 200, {
          ok: true,
          key
        });
      }

      return send(res, 405, {
        error: 'Method not allowed'
      });
    } catch (error) {
      return send(res, 503, {
        error: 'Saqlash amalga oshmadi'
      });
    }
  }

  // CREATE ORDER
  if (
    pathname === '/api/orders' &&
    req.method === 'POST'
  ) {
    const body = await readBody(req);

    if (
      !body.name ||
      !body.phone ||
      !Array.isArray(body.items) ||
      !body.items.length
    ) {
      return send(res, 400, {
        error: 'Buyurtma uchun ism, telefon va mahsulotlar kerak'
      });
    }

    try {
      const orders = await getValue('shoply_orders_v1', []);
      const list = Array.isArray(orders) ? orders : [];

      const order = {
        ...body,
        id: cleanText(body.id, 80) ||
          `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        name: cleanText(body.name, 120),
        phone: cleanText(body.phone, 40),
        address: cleanText(body.address, 500),
        status: 'Yangi',
        createdAt: new Date().toISOString()
      };

      list.unshift(order);

      await setValue(
        'shoply_orders_v1',
        list.slice(0, 10000)
      );

      return send(res, 201, {
        ok: true,
        id: order.id
      });
    } catch (error) {
      return send(res, 503, {
        error: 'Buyurtmani saqlashda xato'
      });
    }
  }

  // GET ORDERS — ADMIN ONLY
  if (
    pathname === '/api/orders' &&
    req.method === 'GET'
  ) {
    if (!adminOnly(req, res)) return;

    try {
      return send(
        res,
        200,
        await getValue('shoply_orders_v1', [])
      );
    } catch (error) {
      return send(res, 503, {
        error: 'Buyurtmalarni yuklab bo‘lmadi'
      });
    }
  }

  // SAVE REVIEW
  if (
    pathname === '/api/reviews' &&
    req.method === 'POST'
  ) {
    const body = await readBody(req);

    if (
      !body.productId ||
      !body.review ||
      !body.review.text
    ) {
      return send(res, 400, {
        error: 'Sharh ma’lumotlari to‘liq emas'
      });
    }

    try {
      const all = await getValue('shoply_reviews_v1', {});

      const reviews =
        all && typeof all === 'object' && !Array.isArray(all)
          ? all
          : {};

      const id = cleanText(body.productId, 100);
      const list = Array.isArray(reviews[id])
        ? reviews[id]
        : [];

      list.push({
        ...body.review,
        productId: id,
        text: cleanText(body.review.text, 700)
      });

      reviews[id] = list.slice(-500);

      await setValue('shoply_reviews_v1', reviews);

      return send(res, 201, {
        ok: true
      });
    } catch (error) {
      return send(res, 503, {
        error: 'Sharhni saqlab bo‘lmadi'
      });
    }
  }

  // CHAT
  if (
    pathname === '/api/chat' &&
    req.method === 'GET'
  ) {
    try {
      return send(res, 200, {
        messages: await getValue('shoply_chat_v1', [])
      });
    } catch (error) {
      return send(res, 503, {
        error: 'Chat yuklanmadi'
      });
    }
  }

  if (
    pathname === '/api/chat' &&
    req.method === 'POST'
  ) {
    const body = await readBody(req, 64 * 1024);
    const text = cleanText(body.text, 1000);

    if (!text) {
      return send(res, 400, {
        error: 'Xabar bo‘sh'
      });
    }

    try {
      const messages = await getValue('shoply_chat_v1', []);
      const list = Array.isArray(messages) ? messages : [];

      list.push({
        id: `MSG-${Date.now()}`,
        name: cleanText(body.name, 100),
        text,
        telegram_id: cleanText(body.telegram_id, 80),
        sender: 'user',
        createdAt: new Date().toISOString()
      });

      await setValue(
        'shoply_chat_v1',
        list.slice(-2000)
      );

      return send(res, 201, {
        ok: true
      });
    } catch (error) {
      return send(res, 503, {
        error: 'Xabarni saqlab bo‘lmadi'
      });
    }
  }

  // STATIC FILES
  let requested = pathname === '/'
    ? '/index.html'
    : pathname;

  const target = path.resolve(ROOT, '.' + requested);
  const relative = path.relative(ROOT, target);

  const allowedExt = new Set([
    '.html', '.css', '.js', '.json',
    '.svg', '.png', '.jpg', '.jpeg',
    '.webp', '.ico', '.woff', '.woff2'
  ]);

  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.basename(target).startsWith('.') ||
    !allowedExt.has(path.extname(target).toLowerCase()) ||
    [
      'server.js',
      'package.json',
      'package-lock.json'
    ].includes(path.basename(target))
  ) {
    return send(res, 403, {
      error: 'Forbidden'
    });
  }

  fs.readFile(target, (error, buffer) => {
    if (error) {
      return send(
        res,
        404,
        'Not found',
        'text/plain; charset=utf-8'
      );
    }

    const ext = path.extname(target).toLowerCase();

    send(
      res,
      200,
      buffer.toString(),
      MIME[ext] || 'application/octet-stream'
    );
  });
}

// START SERVER
const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    console.error('SHOPLY request error:', error);

    if (!res.headersSent) {
      send(res, 500, {
        error: 'Server error'
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SHOPLY Supabase API listening on ${PORT}`);
});
