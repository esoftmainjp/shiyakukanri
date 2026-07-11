'use strict';

// 能動通知の手動実行(設定画面の「今すぐ送信」)。操作施設に対してテスト送信する。
const express = require('express');
const { pool } = require('../db');
const { facilityScope } = require('../services/facility');
const { runForFacility } = require('../services/notify');
const { writeLog } = require('../services/log');

const router = express.Router();

// POST /api/notify/run  操作施設に対して即時送信(重複抑止・有効化フラグを無視)。
router.post('/run', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all || scope.facilityId == null) {
    return res.status(400).json({ error: '対象施設を選択してください' });
  }
  try {
    const result = await runForFacility(pool, scope.facilityId, { force: true, ignoreEnabled: true });
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'notification_state', operationType: '通知テスト送信', facilityId: scope.facilityId,
      after: result,
    });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('通知テスト送信エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
