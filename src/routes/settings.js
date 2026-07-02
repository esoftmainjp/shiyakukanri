'use strict';

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// 全設定を取得 (ログインユーザーは参照可)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM app_settings`);
    const settings = {};
    rows.forEach((r) => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) {
    console.error('設定取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 設定を更新 (管理者のみ)
router.put('/', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'admin') {
    return res.status(403).json({ error: 'この操作の権限がありません' });
  }
  const body = req.body || {};
  try {
    for (const [key, value] of Object.entries(body)) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('設定更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ヘルパー: 設定値を取得
async function getSetting(key, defaultValue) {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows.length ? rows[0].value : defaultValue;
}

module.exports = router;
module.exports.getSetting = getSetting;
