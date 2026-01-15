// server.js
// Minimal search proxy using only Node.js built-ins — no npm installs required.
//
// - Serves files from ./public (index.html and other assets).
// - Proxies GET /search?q=..., GET /proxy?url=..., and /formproxy for form submissions.
// - Does basic HTML rewriting (simple regex-based) to route links/forms back through the proxy.
// - Basic in-memory rate limiting per IP (sliding window).
//
// WARNING: This is an educational example. For production, harden, audit, add TLS, auth, logging, and follow legal terms.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'simple-search-proxy/1.0';
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // max requests per IP per window

// Simple in-memory rate limiter map: ip => [timestamps...]
const rateMap = new Map();

function rateLimitCheck(ip) {
  const now = Date.now();
  const arr = rateMap.get(ip) || [];
  // keep only timestamps within window
  const filtered = arr.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  filtered.push(now);
  rateMap.set(ip, filtered);
  return filtered.length <= RATE_LIMIT_MAX;
}

function sendStaticFile(req, res, filepath) {
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
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(filepath);
    stream.pipe(res);
  });
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Basic HTML rewriting: remove scripts, and rewrite absolute href/action attributes to proxy endpoints.
// This is a lightweight approach using regexes and is not as robust as an HTML parser.
function rewriteHtml(baseUrl, html) {
  if (!html) return html;
  // Remove <script>...</script>
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');

  // Rewrite href="http(s)://..." or href='http(s)://...'
  html = html.replace(/href=(["'])(https?:\/\/[^"'>\s]+)\1/gi, (m, quote, link) => {
    return `href=${quote}/proxy?url=${encodeURIComponent(link)}${quote}`;
  });

  // Rewrite src="http(s)://..." to proxy as well (images/scripts removed above but keep for other resources)
  html = html.replace(/src=(["'])(https?:\/\/[^"'>\s]+)\1/gi, (m, quote, link) => {
    return `src=${quote}/proxy?url=${encodeURIComponent(link)}${quote}`;
  });

  // Rewrite form actions to /formproxy
  html = html.replace(/<form\b([^>]*?)action=(["'])(https?:\/\/[^"'>\s]+)\2/gi, (m, attrs, quote, actionUrl) => {
    // preserve other attributes, set action to /formproxy?url=... (method left unchanged)
    return `<form${attrs}action=${quote}/formproxy?url=${encodeURIComponent(actionUrl)}${quote}`;
  });

  // Also handle forms with single-quoted or unquoted actions less strictly
  html = html.replace(/<form\b([^>]*?)action=([^>\s]+)/gi, (m, attrs, actionVal) => {
    // if actionVal already rewritten or relative, leave it; handle absolute urls without quotes too
    const cleaned = actionVal.replace(/['"]/g, '');
    if (isHttpUrl(cleaned)) {
      return `<form${attrs}action="/formproxy?url=${encodeURIComponent(cleaned)}"`;
    }
    return m;
  });

  // Base-href handling: not implemented (keeps relative URLs as-is)
  return html;
}

function proxyRequest(targetUrl, method, headers, bodyBuffer, clientReq, clientRes) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
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

  // remove incoming cookies and other client-identifying headers
  delete options.headers['cookie'];
  delete options.headers['Cookie'];
  delete options.headers['x-forwarded-for'];

  const proxyLib = parsed.protocol === 'https:' ? https : http;
  const upstream = proxyLib.request(options, (upRes) => {
    const contentType = (upRes.headers['content-type'] || '').toLowerCase();

    // Collect response if it's html for rewriting; otherwise stream directly
    if (contentType.includes('text/html')) {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const body = buffer.toString('utf8');
        const rewritten = rewriteHtml(parsed.origin, body);
        const headersOut = {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        };
        clientRes.writeHead(200, headersOut);
        clientRes.end(rewritten, 'utf8');
      });
    } else {
      // Pipe non-HTML responses back (images, CSS, etc.)
      const headersOut = Object.assign({}, upRes.headers);
      // make sure we do not send back any Set-Cookie or other potentially sensitive headers
      delete headersOut['set-cookie'];
      delete headersOut['Set-Cookie'];
      headersOut['Cache-Control'] = 'no-store';
      clientRes.writeHead(upRes.statusCode || 200, headersOut);
      upRes.pipe(clientRes);
    }
  });

  upstream.on('error', (err) => {
    console.error('Upstream request error:', err && err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    clientRes.end('Bad gateway');
  });

  if (bodyBuffer && bodyBuffer.length) {
    upstream.write(bodyBuffer);
  }
  upstream.end();
}

// Very small helper to collect request body
function collectRequestBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', (err) => cb(err));
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

    // Serve root as public/index.html
    if (pathname === '/' || pathname === '/index.html') {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      sendStaticFile(req, res, indexPath);
      return;
    }

    // Serve other static files from /public
    if (pathname.startsWith('/public/') || pathname.startsWith('/assets/') || pathname.match(/\.(css|js|png|jpg|jpeg|svg|ico)$/i)) {
      // Map requested path to public directory
      let rel = pathname;
      if (rel.startsWith('/')) rel = rel.slice(1);
      const filePath = path.join(PUBLIC_DIR, rel.replace(/^public\//, ''));
      sendStaticFile(req, res, filePath);
      return;
    }

    // Search endpoint: proxies to DuckDuckGo Lite
    if (pathname === '/search' && req.method === 'GET') {
      const q = (parsedUrl.query && parsedUrl.query.q) ? String(parsedUrl.query.q) : '';
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing query parameter q');
        return;
      }
      const target = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q);
      proxyRequest(target, 'GET', {}, null, req, res);
      return;
    }

    // Generic proxy for GET (rewritten links)
    if (pathname === '/proxy' && req.method === 'GET') {
      const target = parsedUrl.query && parsedUrl.query.url ? parsedUrl.query.url : '';
      if (!target || !isHttpUrl(target)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing or invalid url parameter');
        return;
      }
      proxyRequest(target, 'GET', {}, null, req, res);
      return;
    }

    // Form proxy (handles GET and POST)
    if (pathname === '/formproxy') {
      const target = parsedUrl.query && parsedUrl.query.url ? parsedUrl.query.url : '';
      if (!target || !isHttpUrl(target)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing or invalid url parameter');
        return;
      }

      if (req.method === 'GET') {
        // forward query parameters from the original form submission
        const qs = parsedUrl.query ? (() => {
          const copy = Object.assign({}, parsedUrl.query);
          delete copy.url;
          const qstr = querystring.stringify(copy);
          return qstr ? (target + (target.includes('?') ? '&' : '?') + qstr) : target;
        })() : target;
        proxyRequest(qs, 'GET', {}, null, req, res);
        return;
      }

      if (req.method === 'POST') {
        collectRequestBody(req, (err, bodyBuffer) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Server error reading request');
            return;
          }
          // forward as application/x-www-form-urlencoded
          const headers = {
            'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded'
          };
          proxyRequest(target, 'POST', headers, bodyBuffer, req, res);
        });
        return;
      }

      // method not allowed
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    // Health check
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    // If nothing matched, try to serve from public folder relative path
    const possible = path.join(PUBLIC_DIR, decodeURIComponent(pathname).replace(/^\//, ''));
    fs.stat(possible, (err, stats) => {
      if (!err && stats.isFile()) {
        sendStaticFile(req, res, possible);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
    });
  } catch (e) {
    console.error('Unexpected error:', e && e.stack);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`Simple search proxy listening on http://localhost:${PORT}`);
});
