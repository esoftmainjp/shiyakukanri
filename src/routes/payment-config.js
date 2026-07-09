'use strict';

// 決済プロバイダの選択(全体管理者=superadmin のみ)。
//   GET  /api/payment-config   有効プロバイダと一覧(実装済/設定済など)
//   POST /api/payment-config   有効プロバイダを切り替え

const express = require('express');
const { pool } = require('../db');
const payments = require('../services/payments');
const { writeLog } = require('../services/log');
const { getGraceDays, setGraceDays } = require('../services/billing-enforce');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json({ active: await payments.activeKey(), providers: payments.list(), graceDays: await getGraceDays(pool) });
  } catch (err) {
    console.error('決済設定取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 支払失敗の猶予日数を設定(0=自動停止しない)
router.post('/grace', async (req, res) => {
  try {
    const days = await setGraceDays((req.body || {}).days, pool);
    await writeLog(pool, { userId: req.session.user.id, targetTable: 'system_settings', targetId: null, operationType: '更新', after: { payment_grace_days: days } });
    res.json({ ok: true, graceDays: days });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

router.post('/', async (req, res) => {
  const provider = String((req.body || {}).provider || '').trim();
  try {
    await payments.setActive(provider);
    await writeLog(pool, { userId: req.session.user.id, targetTable: 'system_settings', targetId: null, operationType: '更新', after: { payment_provider: provider } });
    res.json({ ok: true, active: provider });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

module.exports = router;
