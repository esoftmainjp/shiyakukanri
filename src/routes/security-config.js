'use strict';

// ログインセキュリティ設定(全体管理者=superadmin のみ)。
//   GET /api/security-config       現在の設定
//   PUT /api/security-config        しきい値・ロック時間・ロック通知メールの有効/無効
// システム全体設定(system_settings)に保存する。

const express = require('express');
const { pool } = require('../db');
const { getSystemSetting, setSystemSetting } = require('../services/system-settings');
const { writeLog } = require('../services/log');

const router = express.Router();

const DEF_MAX = Number(process.env.LOGIN_MAX_FAILED) || 5;
const DEF_MIN = Number(process.env.LOGIN_LOCK_MINUTES) || 15;

router.get('/', async (req, res) => {
  try {
    const maxFailed = parseInt(await getSystemSetting('login_max_failed', String(DEF_MAX)), 10) || DEF_MAX;
    const lockMinutes = parseInt(await getSystemSetting('login_lock_minutes', String(DEF_MIN)), 10) || DEF_MIN;
    const notifyLockout = (await getSystemSetting('notify_lockout_enabled', '1')) === '1';
    res.json({ maxFailed, lockMinutes, notifyLockout });
  } catch (err) {
    console.error('セキュリティ設定取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.put('/', async (req, res) => {
  const b = req.body || {};
  const maxFailed = parseInt(b.maxFailed, 10);
  const lockMinutes = parseInt(b.lockMinutes, 10);
  if (!Number.isFinite(maxFailed) || maxFailed < 1 || maxFailed > 20) {
    return res.status(400).json({ error: '失敗回数は1〜20で指定してください' });
  }
  if (!Number.isFinite(lockMinutes) || lockMinutes < 1 || lockMinutes > 1440) {
    return res.status(400).json({ error: 'ロック時間(分)は1〜1440で指定してください' });
  }
  const notifyLockout = b.notifyLockout ? '1' : '0';
  try {
    await setSystemSetting('login_max_failed', maxFailed);
    await setSystemSetting('login_lock_minutes', lockMinutes);
    await setSystemSetting('notify_lockout_enabled', notifyLockout);
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'system_settings', targetId: null, operationType: '更新',
      after: { login_max_failed: maxFailed, login_lock_minutes: lockMinutes, notify_lockout_enabled: notifyLockout },
    });
    res.json({ ok: true, maxFailed, lockMinutes, notifyLockout: notifyLockout === '1' });
  } catch (err) {
    console.error('セキュリティ設定更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
