'use strict';

const express = require('express');
const { pool } = require('../db');
const { facilityScope } = require('../services/facility');

const router = express.Router();

// 全設定を取得 (ログインユーザーは参照可)。操作施設の設定を返す。
router.get('/', async (req, res) => {
  const scope = facilityScope(req);
  try {
    // 全体管理者が施設未選択(all)のときは全体既定(facility_id IS NULL)を返す
    const fid = scope.all ? null : scope.facilityId;
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE facility_id IS NOT DISTINCT FROM $1`,
      [fid]
    );
    const settings = {};
    rows.forEach((r) => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) {
    console.error('設定取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 設定を更新 (管理者のみ)。操作施設の設定として保存する。
router.put('/', async (req, res) => {
  const ut = req.session.user && req.session.user.userType;
  if (ut !== 'admin' && ut !== 'superadmin') {
    return res.status(403).json({ error: 'この操作の権限がありません' });
  }
  const scope = facilityScope(req);
  const fid = scope.facilityId;
  if (fid == null) return res.status(400).json({ error: '対象施設を選択してください' });
  const body = req.body || {};
  try {
    for (const [key, value] of Object.entries(body)) {
      await pool.query(
        `INSERT INTO app_settings (key, value, facility_id) VALUES ($1, $2, $3)
         ON CONFLICT (facility_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value), fid]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('設定更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ヘルパー: 設定値を取得。施設別の値を優先し、無ければ全体既定(facility_id IS NULL)、
// それも無ければ defaultValue を返す。
async function getSetting(key, defaultValue, facilityId = null) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings
      WHERE key = $1 AND (facility_id = $2 OR facility_id IS NULL)
      ORDER BY facility_id NULLS LAST
      LIMIT 1`,
    [key, facilityId]
  );
  return rows.length ? rows[0].value : defaultValue;
}

module.exports = router;
module.exports.getSetting = getSetting;
