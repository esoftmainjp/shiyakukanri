'use strict';

// 操作ログ閲覧API (管理者のみ。server.js で requireRole('admin') を適用)
const express = require('express');
const { pool } = require('../db');
const { sendCsv } = require('../services/csv');

const router = express.Router();

// 絞り込み条件(WHERE)を構築。GET / と /csv で共用。
function buildLogFilter(q) {
  const conds = [];
  const params = [];
  const add = (frag, val) => { params.push(val); conds.push(frag.replace('$', '$' + params.length)); };
  if (q.from) add('l.created_at >= $', q.from);
  if (q.to) add("l.created_at < ($::date + INTERVAL '1 day')", q.to);
  if (q.userId) add('l.user_id = $', q.userId);
  if (q.operationType) add('l.operation_type = $', q.operationType);
  if (q.targetTable) add('l.target_table = $', q.targetTable);
  if (q.keyword) {
    params.push('%' + q.keyword + '%');
    const p = '$' + params.length;
    conds.push(`(l.target_table ILIKE ${p} OR l.operation_type ILIKE ${p}
                 OR l.before_data::text ILIKE ${p} OR l.after_data::text ILIKE ${p}
                 OR u.name ILIKE ${p} OR CAST(l.target_id AS TEXT) ILIKE ${p})`);
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

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
  ledger: '試薬管理台帳',
  inventory: '在庫一覧',
  logs: '操作ログ',
  receipts_list: '入庫履歴', issues_list: '出庫履歴',
  orders_list: '発注履歴', movements_list: '在庫調整履歴',
  usage_report: '使用量集計', monthly_report: '月次推移',
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

// 操作ログのおおよそのデータ容量と件数
// GET /api/logs/storage
router.get('/storage', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS c,
              pg_total_relation_size('operation_logs') AS total_bytes,
              pg_table_size('operation_logs') AS table_bytes
         FROM operation_logs`
    );
    const row = r.rows[0] || {};
    res.json({
      count: Number(row.c || 0),
      bytes: Number(row.total_bytes || 0),
      tableBytes: Number(row.table_bytes || 0),
    });
  } catch (err) {
    console.error('操作ログ容量エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 操作ログ一覧(絞り込み・ページング)
// GET /api/logs?from&to&userId&operationType&targetTable&keyword&limit&offset
router.get('/', async (req, res) => {
  const q = req.query;
  try {
    const { where, params } = buildLogFilter(q);

    const limit = Math.min(10000, Math.max(1, Number(q.limit) || 50));
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

// 操作ログCSV(絞り込みは一覧と同じ。ページングは無視し全件出力)
// GET /api/logs/csv?from&to&userId&operationType&targetTable&keyword
router.get('/csv', async (req, res) => {
  try {
    const { where, params } = buildLogFilter(req.query);
    const p = params.slice();
    p.push(50000);
    const { rows } = await pool.query(
      `SELECT l.id, l.created_at, u.name AS user_name, u.login_id,
              l.target_table, l.target_id, l.operation_type, l.before_data, l.after_data
         FROM operation_logs l
         LEFT JOIN users u ON u.id = l.user_id
         ${where}
        ORDER BY l.id DESC
        LIMIT $${p.length}`,
      p
    );
    const toStr = (v) => (v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    const data = rows.map((r) => ({
      created_at: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19) : '',
      user_name: r.user_name || '',
      login_id: r.login_id || '',
      operation_type: r.operation_type || '',
      target_table: TABLE_LABELS[r.target_table] || r.target_table || '',
      target_id: r.target_id == null ? '' : r.target_id,
      before_data: toStr(r.before_data),
      after_data: toStr(r.after_data),
    }));
    const columns = [
      { key: 'created_at', label: '日時' },
      { key: 'user_name', label: 'ユーザー' },
      { key: 'login_id', label: 'ログインID' },
      { key: 'operation_type', label: '操作' },
      { key: 'target_table', label: '対象' },
      { key: 'target_id', label: '対象ID' },
      { key: 'before_data', label: '変更前' },
      { key: 'after_data', label: '変更後' },
    ];
    sendCsv(res, '操作ログ.csv', columns, data);
  } catch (err) {
    console.error('操作ログCSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
