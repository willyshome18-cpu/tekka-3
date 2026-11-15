'use strict';
/**
 * Tekka — serveur de la boutique.
 * Aucune dépendance : Node.js 18+ suffit (node server.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_PASSWORD = 'smallstartup';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_UPLOAD = 8 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Stockage JSON (écriture atomique) ---------- */
function writeJson(name, data) {
  const file = path.join(DATA_DIR, name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function loadJson(name, fallback) {
  const file = path.join(DATA_DIR, name + '.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    writeJson(name, fallback);
    return JSON.parse(JSON.stringify(fallback));
  }
  try {
    return JSON.parse(raw);
  } catch {
    // On ne remplace jamais un fichier existant illisible : on s'arrête pour ne rien perdre.
    console.error(`\nERREUR : ${file} est illisible (JSON invalide).`);
    console.error('Corrigez-le ou renommez-le, puis relancez le serveur.\n');
    process.exit(1);
  }
}
const uid = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

const DEFAULT_SETTINGS = {
  shopName: 'Tekka',
  currency: 'DA',
  deliveryFee: 600,
  freeDeliveryFrom: 0,
  contactPhone: '',
  googleMapsKey: '',
  stores: [
    { id: 's1', name: 'Boutique Centre', address: 'Place des Martyrs, Alger', lat: 36.7838, lng: 3.0603, open: 9, close: 18 }
  ]
};
let settings = { ...DEFAULT_SETTINGS, ...loadJson('settings', DEFAULT_SETTINGS) };
let products = loadJson('products', [
  { id: 'p1', name: 'Produit exemple 1', description: 'Modifiez-moi depuis le panneau admin.', price: 12000, oldPrice: 0, image: '', stock: 20, category: 'Général', active: true },
  { id: 'p2', name: 'Produit exemple 2', description: 'Ajoutez votre photo et votre prix.', price: 24500, oldPrice: 28000, image: '', stock: 8, category: 'Général', active: true },
  { id: 'p3', name: 'Produit exemple 3', description: 'Un troisième produit pour la démo.', price: 5900, oldPrice: 0, image: '', stock: 50, category: 'Accessoires', active: true }
]);
let orders = loadJson('orders', []);

/* ---------- Utilitaires ---------- */
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const num = (v, min = 0, max = 1e9) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};
const IMG_RE = /^\/uploads\/[a-f0-9]{16}\.(jpg|png|webp|gif)$/;
const PHONE_RE = /^\+?[\d\s().-]{8,20}$/;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    // Un corps trop gros est lu puis jeté (sans le garder en mémoire) pour pouvoir répondre proprement.
    const chunks = [];
    let size = 0, tooBig = Number(req.headers['content-length']) > limit;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(new HttpError(413, 'Fichier trop volumineux (8 Mo maximum)')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 200 * 1024);
  try {
    const v = JSON.parse(buf.toString('utf8') || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* ignoré */ }
  throw new HttpError(400, 'Requête invalide');
}

/* ---------- Limitation anti-abus ---------- */
const hits = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(req, key, max, windowMs) {
  const k = key + '|' + clientIp(req), now = Date.now();
  let h = hits.get(k);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
  if (++h.n > max) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 60 * 1000).unref();

/* ---------- Session admin ---------- */
const sessions = new Map();
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req) {
  const t = req.headers['x-admin-token'];
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) {
    if (t) sessions.delete(t);
    throw new HttpError(401, 'Non autorisé');
  }
  return t;
}

/* ---------- Produits ---------- */
function cleanProduct(b, old = {}) {
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, 'Le nom du produit est requis');
  const price = Number(b.price);
  if (b.price === '' || b.price == null || !Number.isFinite(price) || price < 0) throw new HttpError(400, 'Prix invalide');
  const image = str(b.image, 300);
  if (image && !IMG_RE.test(image) && !/^https?:\/\/\S+$/i.test(image)) throw new HttpError(400, 'Image invalide');
  const p = Math.round(price * 100) / 100;
  let oldPrice = Math.round(num(b.oldPrice) * 100) / 100;
  if (oldPrice <= p) oldPrice = 0;
  return {
    id: old.id || uid(),
    name,
    description: str(b.description, 1000),
    price: p,
    oldPrice,
    image,
    stock: Math.floor(num(b.stock, 0, 1e6)),
    category: str(b.category, 60) || 'Général',
    active: b.active !== false
  };
}
function dropImageIfUnused(url) {
  if (!url || !IMG_RE.test(url) || products.some(p => p.image === url)) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

/* ---------- Commandes ---------- */
function computeTotals(items, mode) {
  if (!Array.isArray(items)) throw new HttpError(400, 'Panier invalide');
  const merged = new Map();
  for (const it of items.slice(0, 100)) {
    const qty = Math.floor(num(it?.qty, 0, 1000));
    if (qty > 0) merged.set(String(it.id), (merged.get(String(it.id)) || 0) + qty);
  }
  const lines = [];
  for (const [id, qty] of merged) {
    const p = products.find(x => x.id === id && x.active);
    if (!p) throw new HttpError(400, 'Un produit de votre panier n’est plus disponible. Rechargez la page.');
    if (qty > p.stock) throw new HttpError(400, `Stock insuffisant pour « ${p.name} » (reste ${p.stock})`);
    lines.push({ id: p.id, name: p.name, price: p.price, qty });
  }
  if (!lines.length) throw new HttpError(400, 'Panier vide');
  const subtotal = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
  let fee = 0;
  if (mode === 'delivery') fee = settings.freeDeliveryFrom > 0 && subtotal >= settings.freeDeliveryFrom ? 0 : settings.deliveryFee;
  return { lines, subtotal, fee, total: subtotal + fee };
}
function validSlot(slot, store) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2})h00$/.exec(slot);
  if (!m) return false;
  const h = +m[4];
  if (h < store.open || h >= store.close) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (new Date(t).getUTCDate() !== +m[3]) return false;
  const now = Date.now();
  return t >= now - 2 * 864e5 && t <= now + 7 * 864e5;
}
async function createOrder(req, res) {
  rateLimit(req, 'order', 10, 10 * 60 * 1000);
  const b = await readJson(req);
  const mode = b.mode === 'pickup' ? 'pickup' : 'delivery';
  const name = str(b.customer?.name, 100), phone = str(b.customer?.phone, 30);
  if (name.length < 2) throw new HttpError(400, 'Indiquez votre nom');
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 8) throw new HttpError(400, 'Numéro de téléphone invalide');
  const totals = computeTotals(b.items, mode);
  const order = {
    id: 'C' + Date.now().toString(36).toUpperCase() + uid(1).toUpperCase(),
    createdAt: new Date().toISOString(),
    status: 'new',
    mode,
    customer: { name, phone },
    ...totals
  };
  if (mode === 'delivery') {
    order.address = str(b.address, 300);
    order.addressNote = str(b.addressNote, 300);
    if (order.address.length < 5) throw new HttpError(400, 'Indiquez votre adresse de livraison');
  } else {
    const store = settings.stores.find(s => s.id === b.storeId);
    if (!store) throw new HttpError(400, 'Choisissez une boutique');
    const slot = str(b.slot, 30);
    if (!validSlot(slot, store)) throw new HttpError(400, 'Créneau de retrait invalide');
    order.store = { id: store.id, name: store.name, address: store.address };
    order.slot = slot;
  }
  for (const l of totals.lines) products.find(p => p.id === l.id).stock -= l.qty;
  orders.unshift(order);
  writeJson('products', products);
  writeJson('orders', orders);
  json(res, 200, { ok: true, order });
}

/* ---------- Réglages ---------- */
function publicSettings() {
  const { shopName, currency, deliveryFee, freeDeliveryFrom, contactPhone, googleMapsKey, stores } = settings;
  return { shopName, currency, deliveryFee, freeDeliveryFrom, contactPhone, googleMapsKey, stores };
}
function cleanSettings(b) {
  const stores = (Array.isArray(b.stores) ? b.stores : []).slice(0, 50).map(s => {
    const open = Math.floor(num(s.open, 0, 23)), close = Math.floor(num(s.close, 1, 24));
    const name = str(s.name, 80);
    if (!name) throw new HttpError(400, 'Chaque boutique doit avoir un nom');
    if (open >= close) throw new HttpError(400, `${name} : l’heure d’ouverture doit précéder la fermeture`);
    return {
      id: str(s.id, 20) || uid(3),
      name,
      address: str(s.address, 200),
      lat: num(s.lat, -90, 90),
      lng: num(s.lng, -180, 180),
      open,
      close
    };
  });
  const shopName = str(b.shopName, 80);
  if (!shopName) throw new HttpError(400, 'Le nom de la boutique est requis');
  const contactPhone = str(b.contactPhone, 30);
  if (contactPhone && !PHONE_RE.test(contactPhone)) throw new HttpError(400, 'Numéro de contact invalide');
  return {
    shopName,
    currency: str(b.currency, 10) || 'DA',
    deliveryFee: num(b.deliveryFee),
    freeDeliveryFrom: num(b.freeDeliveryFrom),
    contactPhone,
    googleMapsKey: str(b.googleMapsKey, 100),
    stores
  };
}

/* ---------- Upload d'images (corps binaire brut) ---------- */
function detectImage(buf) {
  if (buf.length > 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  }
  return null;
}

/* ---------- Routes API ---------- */
async function api(req, res, method, p) {
  res.setHeader('Cache-Control', 'no-store');

  if (method === 'GET' && p === '/api/products') return json(res, 200, products.filter(x => x.active));
  if (method === 'GET' && p === '/api/settings') return json(res, 200, publicSettings());
  if (method === 'POST' && p === '/api/orders') return createOrder(req, res);

  if (method === 'POST' && p === '/api/admin/login') {
    rateLimit(req, 'login', 8, 10 * 60 * 1000);
    const b = await readJson(req);
    if (!sameSecret(b.password ?? '', ADMIN_PASSWORD)) throw new HttpError(401, 'Mot de passe incorrect');
    hits.delete('login|' + clientIp(req));
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    return json(res, 200, { token });
  }

  if (!p.startsWith('/api/admin/')) throw new HttpError(404, 'Introuvable');
  const token = requireAdmin(req);

  if (method === 'POST' && p === '/api/admin/logout') { sessions.delete(token); return json(res, 200, { ok: true }); }
  if (method === 'GET' && p === '/api/admin/info') return json(res, 200, { defaultPassword: ADMIN_PASSWORD === DEFAULT_PASSWORD });
  if (method === 'GET' && p === '/api/admin/products') return json(res, 200, products);
  if (method === 'GET' && p === '/api/admin/settings') return json(res, 200, settings);
  if (method === 'GET' && p === '/api/admin/orders') return json(res, 200, orders);

  if (method === 'POST' && p === '/api/admin/products') {
    const prod = cleanProduct(await readJson(req));
    products.push(prod);
    writeJson('products', products);
    return json(res, 200, prod);
  }
  let m = /^\/api\/admin\/products\/([a-f0-9]+)$/.exec(p);
  if (m && method === 'PUT') {
    const i = products.findIndex(x => x.id === m[1]);
    if (i < 0) throw new HttpError(404, 'Produit introuvable');
    const before = products[i].image;
    products[i] = cleanProduct(await readJson(req), products[i]);
    writeJson('products', products);
    if (before !== products[i].image) dropImageIfUnused(before);
    return json(res, 200, products[i]);
  }
  if (m && method === 'DELETE') {
    const old = products.find(x => x.id === m[1]);
    if (!old) throw new HttpError(404, 'Produit introuvable');
    products = products.filter(x => x.id !== m[1]);
    writeJson('products', products);
    dropImageIfUnused(old.image);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/admin/upload') {
    const buf = await readBody(req, MAX_UPLOAD);
    const ext = detectImage(buf);
    if (!ext) throw new HttpError(400, 'Image invalide (JPG, PNG, WebP ou GIF)');
    const name = uid(8) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return json(res, 200, { url: '/uploads/' + name });
  }

  if (method === 'PUT' && p === '/api/admin/settings') {
    settings = cleanSettings(await readJson(req));
    writeJson('settings', settings);
    return json(res, 200, settings);
  }

  m = /^\/api\/admin\/orders\/([A-Z0-9]+)$/.exec(p);
  if (m && method === 'PUT') {
    const o = orders.find(x => x.id === m[1]);
    if (!o) throw new HttpError(404, 'Commande introuvable');
    const status = (await readJson(req)).status;
    if (!['new', 'ready', 'done', 'cancelled'].includes(status)) throw new HttpError(400, 'Statut invalide');
    if (o.status === 'cancelled' && status !== 'cancelled') throw new HttpError(400, 'Une commande annulée ne peut plus être modifiée');
    if (status === 'cancelled' && o.status !== 'cancelled') {
      for (const l of o.lines) { const prod = products.find(x => x.id === l.id); if (prod) prod.stock += l.qty; }
      writeJson('products', products);
    }
    o.status = status;
    writeJson('orders', orders);
    return json(res, 200, o);
  }

  throw new HttpError(404, 'Introuvable');
}

/* ---------- Fichiers statiques ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function sendFile(req, res, file, headers) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Page introuvable');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ...headers });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

/* ---------- Serveur ---------- */
async function route(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { throw new HttpError(400, 'URL invalide'); }

  if (p.startsWith('/api/')) return api(req, res, req.method, p);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée');

  if (p.startsWith('/uploads/')) {
    const name = p.slice('/uploads/'.length);
    if (!/^[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(name)) throw new HttpError(404, 'Introuvable');
    return sendFile(req, res, path.join(UPLOAD_DIR, name), { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }
  const rel = p === '/' ? '/index.html' : p;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Introuvable');
  const headers = { 'Cache-Control': 'no-cache' };
  if (rel === '/admin.html') headers['X-Robots-Tag'] = 'noindex, nofollow';
  return sendFile(req, res, file, headers);
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Erreur serveur' });
  });
});

// Supprime les photos envoyées mais jamais rattachées à un produit (plus de 24 h).
function sweepUploads() {
  const used = new Set(products.map(p => path.basename(p.image || '')));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.join(UPLOAD_DIR, f);
    try {
      if (!used.has(f) && Date.now() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(full);
    } catch { /* ignoré */ }
  }
}

if (require.main === module) {
  sweepUploads();
  server.listen(PORT, () => {
    console.log(`Boutique : http://localhost:${PORT}`);
    console.log(`Admin    : http://localhost:${PORT}/admin.html`);
    if (ADMIN_PASSWORD === DEFAULT_PASSWORD) console.log('Mot de passe admin par défaut en vigueur : définissez ADMIN_PASSWORD pour le changer.');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
module.exports = server;
