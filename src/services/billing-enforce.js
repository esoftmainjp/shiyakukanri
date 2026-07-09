'use strict';

// 支払失敗(past_due)からの猶予超過を判定し、超過施設を停止(is_active=FALSE)する。
// 猶予日数は system_settings.payment_grace_days(既定14。0で自動停止しない)。

const { pool } = require('../db');
const { writeLog } = require('./log');

async function getGraceDays(db = pool) {
  try {
    const r = await db.query("SELECT value FROM system_settings WHERE key = 'payment_grace_days'");
    const n = r.rowCount ? Number(r.rows[0].value) : 14;
    return Number.isFinite(n) && n >= 0 ? n : 14;
  } catch (e) { return 14; }
}

async function setGraceDays(days, db = pool) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) { const e = new Error('猶予日数は0以上の整数で入力してください'); e.status = 400; throw e; }
  await db.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('payment_grace_days', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(Math.floor(n))]
  );
  return Math.floor(n);
}

// 猶予超過の past_due 施設を停止する。戻り: { suspended, grace }
async function enforcePastDue(db = pool) {
  const grace = await getGraceDays(db);
  if (!grace || grace <= 0) return { suspended: 0, grace };
  const r = await db.query(
    `UPDATE facilities SET is_active = FALSE
      WHERE billing_status = 'past_due' AND is_active = TRUE
        AND past_due_since IS NOT NULL
        AND past_due_since < now() - ($1 || ' days')::interval
      RETURNING id`,
    [String(grace)]
  );
  for (const row of r.rows) {
    await writeLog(db, { userId: null, targetTable: 'facilities', targetId: row.id, operationType: '更新',
      after: { action: 'suspend_past_due', grace_days: grace }, facilityId: row.id });
  }
  if (r.rowCount) console.log(`[billing] 支払失敗の猶予(${grace}日)超過で施設を停止: ${r.rowCount}件`);
  return { suspended: r.rowCount, grace };
}

module.exports = { getGraceDays, setGraceDays, enforcePastDue };
