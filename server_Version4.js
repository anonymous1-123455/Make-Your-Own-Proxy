// server.js - minimal proxy server using only Node built-ins
// Listens on process.env.PORT (CodeSandbox provides this) or 3000.
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'simple-search-proxy/1.0';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

const rateMap = new Map();
function rateLimitCheck(ip) {
  const now = Date.now();
  const arr = rateMap.get(ip) || [];
  const filtered = arr.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  filtered.push(now);
  rateMap.set(ip, filtered);
  return filtered.length <= RATE_LIMIT_MAX;
}

function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
}

function sendStaticFile(res, filepath) {
  fs.stat(filepath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filepath).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    fs.createReadStream(filepath).pipe(res);
  });
}

// Lightweight HTML rewrite: remove scripts and rewrite absolute links/forms to proxy endpoints
function rewriteHtml(html) {
  if (!html) return html;
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/href=(["'])(https?:\/\/[^"'>\s]+)\1/gi, (m, q, link) => `href=${q}/proxy?url=${encodeURIComponent(link)}${q}`);
  html = html.replace(/src=(["'])(https?:\/\/[^"'>\s]+)\1/gi, (m, q, link) => `src=${q}/proxy?url=${encodeURIComponent(link)}${q}`);
  html = html.replace(/<form\b([^>]*?)action=(["'])(https?:\/\/[^"'>\s]+)\2/gi, (m, attrs, q, actionUrl) => `<form${attrs}action=${q}/formproxy?url=${encodeURIComponent(actionUrl)}${q}`);
  html = html.replace(/<form\b([^>]*?)action=([^>\s]+)/gi, (m, attrs, actionVal) => {
    const cleaned = actionVal.replace(/['"]/g, '');
    if (isHttpUrl(cleaned)) return `<form${attrs}action="/formproxy?url=${encodeURIComponent(cleaned)}"`;
    return m;
  });
  return html;
}

function proxyRequest(targetUrl, method, headers, bodyBuffer, clientRes) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientRes.end('Invalid target URL');
    return;
  }

  const options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + (parsed.search || ''),
    method: method,
    headers: Object.assign({
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }, headers || {})
  };

  delete options.headers['cookie'];
  delete options.headers['Cookie'];
  delete options.headers['x-forwarded-for'];

  const lib = parsed.protocol === 'https:' ? https : http;
  const upstream = lib.request(options, (upRes) => {
    const contentType = (upRes.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteHtml(body);
        clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        clientRes.end(rewritten, 'utf8');
      });
    } else {
      const headersOut = Object.assign({}, upRes.headers);
      delete headersOut['set-cookie'];
      delete headersOut['Set-Cookie'];
      headersOut['Cache-Control'] = 'no-store';
      clientRes.writeHead(upRes.statusCode || 200, headersOut);
      upRes.pipe(clientRes);
    }
  });

  upstream.on('error', (err) => {
    console.error('Upstream error:', err && err.message);
    if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientRes.end('Bad gateway');
  });

  if (bodyBuffer && bodyBuffer.length) upstream.write(bodyBuffer);
  upstream.end();
}

function collectRequestBody(req, callback) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => callback(null, Buffer.concat(chunks)));
  req.on('error', (err) => callback(err));
}

const server = http.createServer((req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!rateLimitCheck(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too many requests');
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '/';

    if (pathname === '/' || pathname === '/index.html') {
      sendStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }

    // Serve static assets under /public
    if (pathname.startsWith('/public/') || pathname.match(/\.(css|js|png|jpg|jpeg|svg|ico)$/i)) {
      const rel = pathname.replace(/^\/+/, '');
      const filepath = path.join(PUBLIC_DIR, rel.replace(/^public\//, ''));
      sendStaticFile(res, filepath);
      return;
    }

    if (pathname === '/search' && req.method === 'GET') {
      const q = parsedUrl.query && parsedUrl.query.q ? String(parsedUrl.query.q) : '';
      if (!q) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Missing query parameter q'); return; }
      const target = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q);
      proxyRequest(target, 'GET', {}, null, res);
      return;
    }

    if (pathname === '/proxy' && req.method === 'GET') {
      const target = parsedUrl.query && parsedUrl.query.url ? parsedUrl.query.url : '';
      if (!target || !isHttpUrl(target)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Missing or invalid url parameter'); return; }
      proxyRequest(target, 'GET', {}, null, res);
      return;
    }

    if (pathname === '/formproxy') {
      const target = parsedUrl.query && parsedUrl.query.url ? parsedUrl.query.url : '';
      if (!target || !isHttpUrl(target)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Missing or invalid url parameter'); return; }

      if (req.method === 'GET') {
        const copy = Object.assign({}, parsedUrl.query); delete copy.url;
        const qstr = querystring.stringify(copy);
        const qs = qstr ? (target + (target.includes('?') ? '&' : '?') + qstr) : target;
        proxyRequest(qs, 'GET', {}, null, res);
        return;
      }

      if (req.method === 'POST') {
        collectRequestBody(req, (err, bodyBuffer) => {
          if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error reading request'); return; }
          const headers = { 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' };
          proxyRequest(target, 'POST', headers, bodyBuffer, res);
        });
        return;
      }

      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    console.error('Unexpected error:', e && e.stack);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`Simple search proxy listening on http://localhost:${PORT}`);
});