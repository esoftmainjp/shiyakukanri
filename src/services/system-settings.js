'use strict';

// システム全体設定(施設非依存の system_settings KV)の読み書きヘルパー。
// 例: login_max_failed / login_lock_minutes / notify_lockout_enabled など。
const { pool } = require('../db');

async function getSystemSetting(key, defaultValue = null) {
  const r = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  return r.rowCount ? r.rows[0].value : defaultValue;
}

async function setSystemSetting(key, value) {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}

module.exports = { getSystemSetting, setSystemSetting };
