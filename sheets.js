const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbModule = require('./db');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const ENV_PATH = path.join(__dirname, '.env');

let accessToken = '';
let tokenExpiresAt = 0;
let spreadsheetTitle = '';

function loadEnv() {
  const env = {
    PORT: 3000,
    SPREADSHEET_ID: '1aMOwYPWqLBOqw_WNSppXDbGjRPHacfj-6hT9l5BsvOA',
    SHEET_EMPLOYEES: 'EMPLOYEES',
    SHEET_LOG: 'SHEET_LOG',
    SHEET_ALLOWANCE: 'Daily Allowance',
    ALLOWANCE_AMOUNT: 100,
    PENDING_ALLOWANCE: 700,
    ADMIN_ID: 'admin'
  };

  if (fs.existsSync(ENV_PATH)) {
    fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key === 'PORT') env.PORT = Number(value);
      else if (key === 'ALLOWANCE_AMOUNT') env.ALLOWANCE_AMOUNT = Number(value);
      else if (key === 'PENDING_ALLOWANCE') env.PENDING_ALLOWANCE = Number(value);
      else env[key] = value;
    });
  }

  return env;
}

const config = loadEnv();

function getCredentials() {
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;

  const creds = getCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: creds.token_uri,
    exp: now + 3600,
    iat: now
  }));

  const unsigned = header + '.' + claim;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  sign.end();
  const signature = sign.sign(creds.private_key);
  const jwt = unsigned + '.' + base64url(signature);

  const res = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Could not authenticate with Google');

  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return accessToken;
}

async function sheetsRequest(pathSuffix, options = {}) {
  const token = await getAccessToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + config.SPREADSHEET_ID + pathSuffix;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }

  if (!res.ok) {
    const msg = data.error?.message || text || res.statusText;
    throw new Error(msg);
  }
  return data;
}

async function getSpreadsheetMeta() {
  const data = await sheetsRequest('');
  spreadsheetTitle = data.properties?.title || 'Google Sheet';
  return data;
}

async function readRange(tab, range) {
  const encoded = encodeURIComponent(tab + '!' + range);
  const data = await sheetsRequest('/values/' + encoded);
  return data.values || [];
}

async function appendRow(tab, values) {
  const encoded = encodeURIComponent(tab + '!A:Z');
  await sheetsRequest('/values/' + encoded + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ values: [values] })
  });
}

function normalizeEmployeeRow(row) {
  const id = String(row[0] || '').trim();
  if (!id || /^employee\s*id$/i.test(id)) return null;
  return {
    id,
    name: String(row[1] || '').trim(),
    position: String(row[2] || '').trim()
  };
}

async function loadEmployeesFromSheet() {
  const rows = await readRange(config.SHEET_EMPLOYEES, 'A2:C');
  const employees = rows.map(normalizeEmployeeRow).filter(Boolean);
  if (employees.length) dbModule.upsertEmployees(employees);
  return employees;
}

async function findEmployee(employeeId) {
  const local = dbModule.getEmployee(employeeId);
  if (local) return local;
  const employees = await loadEmployeesFromSheet();
  return employees.find((e) => e.id === employeeId) || null;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

function formatDate(date) {
  return date.toLocaleDateString('en-CA');
}

async function ping() {
  const meta = await getSpreadsheetMeta();
  const tabNames = (meta.sheets || []).map((s) => s.properties.title);
  const required = [config.SHEET_EMPLOYEES, config.SHEET_LOG];
  const missingSheets = required.filter((name) => !tabNames.includes(name));

  let employeeCount = 0;
  if (!missingSheets.length) {
    const employees = await loadEmployeesFromSheet();
    employeeCount = employees.length;
  }

  return {
    ok: missingSheets.length === 0,
    spreadsheet: spreadsheetTitle,
    employeeCount,
    missingSheets,
    tabs: tabNames
  };
}

async function recordScan(employeeId) {
  const employee = await findEmployee(employeeId);
  if (!employee) {
    return { ok: false, error: 'Employee ID not found: ' + employeeId, id: employeeId };
  }

  const now = new Date();
  const logDate = formatDate(now);
  const time = formatTime(now);
  const lastLocal = dbModule.getLastLogToday(employee.id, logDate);
  const status = lastLocal && lastLocal.status === 'Time In' ? 'Time Out' : 'Time In';
  const logRow = [logDate, employee.id, employee.name, employee.position, status, time];

  let allowance = { ok: false, skipped: true, amount: config.ALLOWANCE_AMOUNT };
  let pendingAllowance = { ok: false, skipped: true, amount: config.PENDING_ALLOWANCE };

  try {
    await appendRow(config.SHEET_LOG, logRow);

    if (status === 'Time In') {
      // Check if user is not admin
      const isAdmin = String(employee.id).toLowerCase() === String(config.ADMIN_ID).toLowerCase();

      if (!isAdmin) {
        // Release daily allowance
        const allowanceRow = [employee.id, employee.name, config.ALLOWANCE_AMOUNT, logDate, time];
        try {
          await appendRow(config.SHEET_ALLOWANCE, allowanceRow);
          dbModule.insertAllowance({
            employee_id: employee.id,
            name: employee.name,
            amount: config.ALLOWANCE_AMOUNT,
            log_date: logDate
          });
          allowance = { ok: true, skipped: false, amount: config.ALLOWANCE_AMOUNT };
        } catch (allowErr) {
          allowance = { ok: false, skipped: true, amount: config.ALLOWANCE_AMOUNT, error: allowErr.message };
        }

        // Release pending allowance
        try {
          await appendRow(config.SHEET_ALLOWANCE, [employee.id, employee.name, config.PENDING_ALLOWANCE, logDate, time]);
          dbModule.insertAllowance({
            employee_id: employee.id,
            name: employee.name,
            amount: config.PENDING_ALLOWANCE,
            log_date: logDate
          });
          pendingAllowance = { ok: true, skipped: false, amount: config.PENDING_ALLOWANCE };
        } catch (pendingErr) {
          pendingAllowance = { ok: false, skipped: true, amount: config.PENDING_ALLOWANCE, error: pendingErr.message };
        }
      }
    }
  } catch (sheetErr) {
    return { ok: false, error: 'Could not write to Google Sheet: ' + sheetErr.message, id: employeeId };
  }

  dbModule.insertAttendance({
    employee_id: employee.id,
    name: employee.name,
    position: employee.position,
    status,
    logged_at: time,
    log_date: logDate,
    synced_to_sheets: 1
  });

  return {
    ok: true,
    id: employee.id,
    name: employee.name,
    position: employee.position,
    status,
    time,
    allowance,
    pendingAllowance
  };
}

async function getTodayLogs() {
  const logDate = formatDate(new Date());

  try {
    const rows = await readRange(config.SHEET_LOG, 'A2:F');
    const todayRows = rows
      .filter((row) => String(row[0] || '').slice(0, 10) === logDate)
      .map((row) => ({
        id: String(row[1] || '').trim(),
        name: String(row[2] || '').trim(),
        position: String(row[3] || '').trim(),
        status: String(row[4] || '').trim(),
        time: String(row[5] || '').trim()
      }))
      .filter((row) => row.id)
      .reverse();

    if (todayRows.length) return { ok: true, rows: todayRows };
  } catch (err) {
    // fall back to local DB
  }

  return { ok: true, rows: dbModule.getTodayLogs(logDate) };
}

async function getAllowanceData() {
  const logDate = formatDate(new Date());
  const amount = config.ALLOWANCE_AMOUNT;
  let rows = [];

  try {
    const sheetRows = await readRange(config.SHEET_ALLOWANCE, 'A2:E');
    rows = sheetRows.map((row, idx) => ({
      scanId: idx + 1,
      id: String(row[0] || '').trim(),
      name: String(row[1] || '').trim(),
      scan: 'Time In',
      allowance: Number(row[2] || amount),
      date: String(row[3] || '').trim(),
      isToday: String(row[3] || '').slice(0, 10) === logDate
    }));
  } catch (err) {
    rows = dbModule.getAllowanceRows().map((row, idx) => ({
      scanId: idx + 1,
      id: row.id,
      name: row.name,
      scan: 'Time In',
      allowance: Number(row.allowance || amount),
      date: row.date,
      isToday: row.date === logDate
    }));
  }

  const totalReleased = rows
    .filter((r) => r.isToday)
    .reduce((sum, r) => sum + Number(r.allowance || 0), 0);

  const totalPending = rows.length > 0 ? config.PENDING_ALLOWANCE : 0;

  return {
    ok: true,
    date: logDate,
    amount,
    tab: config.SHEET_ALLOWANCE,
    rows,
    totalReleased,
    totalPending
  };
}

async function listEmployees() {
  const employees = await loadEmployeesFromSheet();
  return { ok: true, employees };
}

module.exports = {
  config,
  ping,
  recordScan,
  getTodayLogs,
  getAllowanceData,
  listEmployees
};
