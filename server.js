
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, TablesDB } = require('node-appwrite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID = process.env.APPWRITE_TABLE_ID;

const KEYS = [
  'mono_store_products_v2',
  'mono_store_settings_v2',
  'mono_store_slides_v2',
  'mono_store_cart_events_v1',
  'shoply_orders_v1',
  'shoply_reviews_v1'
];

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const db = new TablesDB(client);

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > 25e6) {
        reject(Error('Too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function getValue(key) {
  try {
    const row = await db.getRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId: key
    });
    return { found: true, value: JSON.parse(row.storeValue) };
  } catch (e) {
    if (e.code === 404) return { found: false };
    throw e;
  }
}

async function setValue(key, value) {
  const data = {
    storeKey: key,
    storeValue: JSON.stringify(value)
  };

  try {
    await db.updateRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId: key,
      data
    });
  } catch (e) {
    if (e.code !== 404) throw e;

    await db.createRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId: key,
      data
    });
  }
}

async function deleteValue(key) {
  try {
    await db.deleteRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId: key
    });
  } catch (e) {
    if (e.code !== 404) throw e;
  }
}

async function getOrders() {
  const result = await getValue('orders_data_v1');
  return result.found ? result.value : [];
}

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

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    if (!DATABASE_ID || !TABLE_ID ||
        !process.env.APPWRITE_ENDPOINT ||
        !process.env.APPWRITE_PROJECT_ID ||
        !process.env.APPWRITE_API_KEY) {
      return send(res, 500, { error: 'Appwrite environment is incomplete' });
    }

    if (u.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        service: 'SHOPLY Appwrite API'
      });
    }

    if (u.pathname === '/api/state' && req.method === 'GET') {
      const result = {};
      for (const key of KEYS) {
        const item = await getValue(key);
        if (item.found) result[key] = item.value;
      }
      return send(res, 200, result);
    }

    if (u.pathname.startsWith('/api/state/')) {
      const key = decodeURIComponent(u.pathname.slice('/api/state/'.length));

      if (!KEYS.includes(key)) {
        return send(res, 400, { error: 'Unknown shared key' });
      }

      if (req.method === 'GET') {
        const item = await getValue(key);
        return item.found
          ? send(res, 200, { key, value: item.value })
          : send(res, 404, { error: 'Not found' });
      }

      if (req.method === 'PUT') {
        const b = await body(req);
        await setValue(key, b.value);
        return send(res, 200, { ok: true, key });
      }

      if (req.method === 'DELETE') {
        await deleteValue(key);
        return send(res, 200, { ok: true, key });
      }

      return send(res, 405, { error: 'Method not allowed' });
    }

    if (u.pathname === '/api/orders' && req.method === 'GET') {
      return send(res, 200, await getOrders());
    }

    if (u.pathname === '/api/orders' && req.method === 'POST') {
      const o = await body(req);

      if (!o || !o.name || !o.phone ||
          !Array.isArray(o.items) || !o.items.length) {
        return send(res, 400, {
          error: 'Order needs name, phone and items'
        });
      }

      const list = await getOrders();
      const order = {
        ...o,
        id: o.id || 'ORD-' + Date.now(),
        createdAt: o.createdAt || new Date().toISOString(),
        status: o.status || 'Yangi'
      };

      list.unshift(order);
      await setValue('orders_data_v1', list.slice(0, 10000));

      return send(res, 201, { ok: true, id: order.id });
    }

    if (u.pathname.startsWith('/api/orders/') && req.method === 'PATCH') {
      const id = decodeURIComponent(u.pathname.slice('/api/orders/'.length));
      const b = await body(req);
      const list = await getOrders();
      const order = list.find(x => String(x.id) === id);

      if (!order) return send(res, 404, { error: 'Order not found' });

      if (b.status) order.status = String(b.status).slice(0, 60);

      await setValue('orders_data_v1', list);
      return send(res, 200, { ok: true, order });
    }

    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';

    const file = path.resolve(ROOT, '.' + p);

    if (!file.startsWith(ROOT + path.sep) ||
        file.startsWith(path.join(ROOT, 'data') + path.sep)) {
      return send(res, 403, { error: 'Forbidden' });
    }

    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');

      send(
        res,
        200,
        data.toString(),
        mime[path.extname(file).toLowerCase()] || 'application/octet-stream'
      );
    });

  } catch (e) {
    console.error('SHOPLY ERROR:', e);
    if (!res.headersSent) {
      send(res, 500, { error: 'Server error', detail: e.message });
    }
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('SHOPLY Appwrite server running on port ' + PORT);
});
