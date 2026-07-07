'use strict';

// 施設のプラン(上限・機能フラグ)を扱う共通サービス。

const { pool } = require('../db');

// 施設のプランを取得する。db は pool か tx client(未指定は pool)。
// 戻り値: plans の行(code,name,max_users,max_products,log_retention_days,feat_*)。無ければ null。
async function getFacilityPlan(db, facilityId) {
  if (facilityId == null) return null;
  const client = db || pool;
  const r = await client.query(
    `SELECT p.* FROM facilities f JOIN plans p ON p.code = f.plan_code WHERE f.id = $1`,
    [facilityId]
  );
  return r.rowCount ? r.rows[0] : null;
}

// 上限に対して、あと1件追加できるか。max が NULL(無制限) なら常に true。
function canAdd(currentCount, max) {
  if (max == null) return true;
  return Number(currentCount) < Number(max);
}

module.exports = { getFacilityPlan, canAdd };
