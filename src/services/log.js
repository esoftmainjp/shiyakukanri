'use strict';

const { getContext } = require('./context');

// 操作ログを記録する。db は pool または トランザクションの client。
// before/after はオブジェクト(JSONBに保存)。
// facilityId を明示しない場合はリクエストコンテキストの操作施設を自動付与する
// (全体管理者が施設選択中に行った操作も、その施設のログとして残る)。
async function writeLog(db, { userId = null, targetTable = '', targetId = null, operationType = '', before = null, after = null, facilityId }) {
  try {
    const fac = (facilityId !== undefined) ? facilityId : getContext().facilityId;
    await db.query(
      `INSERT INTO operation_logs
         (user_id, facility_id, target_table, target_id, operation_type, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        fac != null ? fac : null,
        targetTable,
        targetId,
        operationType,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ]
    );
  } catch (err) {
    // ログ失敗は本処理を止めない
    console.error('操作ログ記録エラー:', err.message);
  }
}

module.exports = { writeLog };
