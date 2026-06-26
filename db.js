const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'attendance.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS attendance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT DEFAULT '',
    status TEXT NOT NULL,
    logged_at TEXT NOT NULL,
    log_date TEXT NOT NULL,
    synced_to_sheets INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS allowance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    name TEXT NOT NULL,
    amount REAL NOT NULL,
    log_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function upsertEmployees(rows) {
  const stmt = db.prepare(`
    INSERT INTO employees (id, name, position)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      position = excluded.position
  `);
  for (const row of rows) stmt.run(row.id, row.name, row.position);
}

function getEmployee(id) {
  return db.prepare('SELECT id, name, position FROM employees WHERE id = ?').get(id);
}

function getLastLogToday(employeeId, logDate) {
  return db.prepare(`
    SELECT employee_id, status FROM attendance_log
    WHERE employee_id = ? AND log_date = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(employeeId, logDate);
}

function insertAttendance(entry) {
  db.prepare(`
    INSERT INTO attendance_log (employee_id, name, position, status, logged_at, log_date, synced_to_sheets)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.employee_id,
    entry.name,
    entry.position,
    entry.status,
    entry.logged_at,
    entry.log_date,
    entry.synced_to_sheets
  );
}

function insertAllowance(entry) {
  db.prepare(`
    INSERT INTO allowance_log (employee_id, name, amount, log_date)
    VALUES (?, ?, ?, ?)
  `).run(entry.employee_id, entry.name, entry.amount, entry.log_date);
}

function getTodayLogs(logDate) {
  return db.prepare(`
    SELECT employee_id AS id, name, position, status, logged_at AS time
    FROM attendance_log
    WHERE log_date = ?
    ORDER BY id DESC
  `).all(logDate);
}

function getAllowanceRows() {
  return db.prepare(`
    SELECT
      id AS scanId,
      employee_id AS id,
      name,
      amount AS allowance,
      log_date AS date
    FROM allowance_log
    ORDER BY id DESC
  `).all();
}

module.exports = {
  upsertEmployees,
  getEmployee,
  getLastLogToday,
  insertAttendance,
  insertAllowance,
  getTodayLogs,
  getAllowanceRows
};
