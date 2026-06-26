const http = require('http');
const fs = require('fs');
const path = require('path');
const sheets = require('./sheets');

const PORT = sheets.config.PORT || 3000;
const WEB_ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({}); }
    });
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/attendance.html') urlPath = '/index.html';
  if (urlPath === '/daily-allowance.html') urlPath = '/allowance.html';

  const filePath = path.normalize(path.join(WEB_ROOT, urlPath));
  if (!filePath.startsWith(WEB_ROOT)) {
    sendText(res, 403, 'Forbidden', 'text/plain');
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handleApi(req, res, query) {
  const action = query.action || (req.url === '/api/ping' ? 'ping' : req.url === '/api/today' ? 'today' : req.url === '/api/allowance' ? 'allowance' : req.url === '/api/employees' ? 'employees' : '');

  if (req.method === 'POST' && req.url.startsWith('/api/scan')) {
    const body = await parseBody(req);
    return sheets.recordScan(String(body.id || '').trim());
  }

  if (action === 'ping') return sheets.ping();
  if (action === 'scan') return sheets.recordScan(String(query.id || '').trim());
  if (action === 'today') return sheets.getTodayLogs();
  if (action === 'allowance') return sheets.getAllowanceData();
  if (action === 'employees') return sheets.listEmployees();
  if (req.url === '/api/health') return { ok: true, service: 'bj-attendance-backend' };

  return { ok: false, error: 'Unknown API route' };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams.entries());

    if (req.url.startsWith('/api/')) {
      const data = await handleApi(req, res, query);
      const callback = query.callback;
      if (callback) {
        sendText(res, 200, callback + '(' + JSON.stringify(data) + ')', 'application/javascript; charset=utf-8');
      } else {
        sendJson(res, 200, data);
      }
      return;
    }

    if (serveStatic(req, res)) return;
    sendText(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('B&J Attendance backend running at http://localhost:' + PORT);
  console.log('Open attendance at http://localhost:' + PORT + '/scan.html');
  console.log('Spreadsheet ID:', sheets.config.SPREADSHEET_ID);
  console.log('Service account:', JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8')).client_email);
});
