'use strict';

// 操作ログを記録する。db は pool または トランザクションの client。
// before/after はオブジェクト(JSONBに保存)。
async function writeLog(db, { userId = null, targetTable = '', targetId = null, operationType = '', before = null, after = null }) {
  try {
    await db.query(
      `INSERT INTO operation_logs
         (user_id, target_table, target_id, operation_type, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
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
