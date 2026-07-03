'use strict';

// 操作ログ閲覧API (管理者のみ。server.js で requireRole('admin') を適用)
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// 対象テーブルの和名(表示用)
const TABLE_LABELS = {
  users: 'ユーザー',
  products: '商品',
  product_details: '商品詳細',
  suppliers: '問屋',
  receipts: '入庫',
  receipt_details: '入庫明細',
  issues: '出庫',
  issue_details: '出庫明細',
  orders: '発注',
  order_details: '発注明細',
  barcodes: 'バーコード',
  usage_records: '使用記録',
  stock_movements: '在庫変動',
  product_stocks: '在庫',
  app_settings: '設定',
};

// フィルタ用の候補(操作区分・対象テーブル・ユーザー)
// GET /api/logs/meta
router.get('/meta', async (req, res) => {
  try {
    const ops = await pool.query(
      `SELECT DISTINCT operation_type FROM operation_logs WHERE operation_type <> '' ORDER BY operation_type`
    );
    const tables = await pool.query(
      `SELECT DISTINCT target_table FROM operation_logs WHERE target_table <> '' ORDER BY target_table`
    );
    const users = await pool.query(
      `SELECT id, name, login_id FROM users ORDER BY name`
    );
    res.json({
      operationTypes: ops.rows.map((r) => r.operation_type),
      targetTables: tables.rows.map((r) => ({ value: r.target_table, label: TABLE_LABELS[r.target_table] || r.target_table })),
      users: users.rows,
    });
  } catch (err) {
    console.error('操作ログmetaエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 操作ログ一覧(絞り込み・ページング)
// GET /api/logs?from&to&userId&operationType&targetTable&keyword&limit&offset
router.get('/', async (req, res) => {
  const q = req.query;
  const conds = [];
  const params = [];
  const add = (frag, val) => { params.push(val); conds.push(frag.replace('$', '$' + params.length)); };
  try {
    if (q.from) add('l.created_at >= $', q.from);
    if (q.to) add("l.created_at < ($::date + INTERVAL '1 day')", q.to);
    if (q.userId) add('l.user_id = $', q.userId);
    if (q.operationType) add('l.operation_type = $', q.operationType);
    if (q.targetTable) add('l.target_table = $', q.targetTable);
    if (q.keyword) {
      const kw = '%' + q.keyword + '%';
      params.push(kw);
      const p = '$' + params.length;
      conds.push(`(l.target_table ILIKE ${p} OR l.operation_type ILIKE ${p}
                   OR l.before_data::text ILIKE ${p} OR l.after_data::text ILIKE ${p}
                   OR u.name ILIKE ${p} OR CAST(l.target_id AS TEXT) ILIKE ${p})`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);

    const countRes = await pool.query(
      `SELECT COUNT(*) AS c FROM operation_logs l LEFT JOIN users u ON u.id = l.user_id ${where}`,
      params
    );
    const total = Number(countRes.rows[0].c);

    const listParams = params.slice();
    listParams.push(limit, offset);
    const rows = await pool.query(
      `SELECT l.id, l.created_at, l.user_id, u.name AS user_name, u.login_id,
              l.target_table, l.target_id, l.operation_type, l.before_data, l.after_data
         FROM operation_logs l
         LEFT JOIN users u ON u.id = l.user_id
         ${where}
        ORDER BY l.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const items = rows.rows.map((r) => ({
      ...r,
      target_table_label: TABLE_LABELS[r.target_table] || r.target_table,
    }));
    res.json({ items, total, limit, offset });
  } catch (err) {
    console.error('操作ログ一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
