
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL yoki SUPABASE_SERVICE_ROLE_KEY topilmadi!');
  process.exit(1);
}

const KEYS = new Set([
  'mono_store_products_v2',
  'mono_store_settings_v2',
  'mono_store_slides_v2',
  'mono_store_cart_events_v1',
  'shoply_orders_v1',
  'shoply_reviews_v1'
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

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 25e6) {
        reject(new Error('Request too large'));
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

async function supabaseRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Supabase error:', response.status, error);
    throw new Error(`Database error: ${response.status}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getValue(key, fallback = null) {
  const rows = await supabaseRequest(
    `shoply_data?select=key,value&key=eq.${encodeURIComponent(key)}`
  );

  return rows && rows.length ? rows[0].value : fallback;
}

async function setValue(key, value) {
  await supabaseRequest('shoply_data?on_conflict=key', {
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

async function removeValue(key) {
  await supabaseRequest(
    `shoply_data?key=eq.${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  );
}

async function readRequest(req) {
  return body(req);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        service: 'SHOPLY Supabase API'
      });
    }

    // Barcha umumiy ma'lumotlar
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const result = {};

      for (const key of KEYS) {
        const value = await getValue(key);
        if (value !== null) result[key] = value;
      }

      return send(res, 200, result);
    }

    // Bitta ma'lumotni olish, saqlash yoki o'chirish
    if (url.pathname.startsWith('/api/state/')) {
      const key = decodeURIComponent(
        url.pathname.slice('/api/state/'.length)
      );

      if (!KEYS.has(key)) {
        return send(res, 400, { error: 'Unknown shared key' });
      }

      if (req.method === 'GET') {
        const value = await getValue(key);

        if (value === null) {
          return send(res, 404, { error: 'Not found' });
        }

        return send(res, 200, { key, value });
      }

      if (req.method === 'PUT') {
        const data = await readRequest(req);
        await setValue(key, data.value);

        return send(res, 200, { ok: true, key });
      }

      if (req.method === 'DELETE') {
        await removeValue(key);
        return send(res, 200, { ok: true, key });
      }

      return send(res, 405, { error: 'Method not allowed' });
    }

    // Buyurtmalarni olish
    if (url.pathname === '/api/orders' && req.method === 'GET') {
      const orders = await getValue('shoply_orders_v1', []);
      return send(res, 200, Array.isArray(orders) ? orders : []);
    }

    // Yangi buyurtma
    if (url.pathname === '/api/orders' && req.method === 'POST') {
      const orderData = await readRequest(req);

      if (
        !orderData ||
        !orderData.name ||
        !orderData.phone ||
        !Array.isArray(orderData.items) ||
        !orderData.items.length
      ) {
        return send(res, 400, {
          error: 'Order needs name, phone and items'
        });
      }

      const orders = await getValue('shoply_orders_v1', []);

      const order = {
        ...orderData,
        id: orderData.id || 'ORD-' + Date.now(),
        createdAt: orderData.createdAt || new Date().toISOString(),
        status: orderData.status || 'Yangi'
      };

      orders.unshift(order);
      await setValue('shoply_orders_v1', orders.slice(0, 10000));

      return send(res, 201, { ok: true, id: order.id });
    }

    // Buyurtma holatini o'zgartirish
    if (
      url.pathname.startsWith('/api/orders/') &&
      req.method === 'PATCH'
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/api/orders/'.length)
      );

      const data = await readRequest(req);
      const orders = await getValue('shoply_orders_v1', []);

      const order = orders.find(item => String(item.id) === id);

      if (!order) {
        return send(res, 404, { error: 'Order not found' });
      }

      if (data.status) {
        order.status = String(data.status).slice(0, 60);
      }

      await setValue('shoply_orders_v1', orders);

      return send(res, 200, { ok: true, order });
    }

    // Sayt fayllari
    let requestedPath = decodeURIComponent(url.pathname);

    if (requestedPath === '/') {
      requestedPath = '/index.html';
    }

    const file = path.resolve(ROOT, '.' + requestedPath);

    if (
      !file.startsWith(ROOT + path.sep) ||
      file.includes(`${path.sep}data${path.sep}`)
    ) {
      return send(res, 403, { error: 'Forbidden' });
    }

    fs.readFile(file, (error, content) => {
      if (error) {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8'
        });
        return res.end('Not found');
      }

      res.writeHead(200, {
        'Content-Type':
          MIME[path.extname(file).toLowerCase()] ||
          'application/octet-stream',
        'Cache-Control': 'no-store'
      });

      res.end(content);
    });

  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      send(res, 500, { error: 'Server error' });
    }
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('SHOPLY Supabase API ishga tushdi:', PORT);
});
