'use strict';

// データベース使用量の詳細API (全体管理者=superadmin のみ。
// server.js で requireRole('superadmin') を適用)。
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// テーブル名の和名(表示用)。未登録は英語名のまま。
const TABLE_LABELS = {
  products: '商品', product_details: '商品詳細', suppliers: '問屋', makers: 'メーカー',
  departments: '部門', categories: '分類', users: 'ユーザー', app_settings: '設定',
  operation_logs: '操作ログ', facilities: '施設', barcodes: 'バーコード',
  product_stocks: '在庫', stock_movements: '在庫変動', usage_records: '使用記録',
  receipts: '入庫', receipt_details: '入庫明細', issues: '出庫', issue_details: '出庫明細',
  orders: '発注', order_details: '発注明細', order_plans: '発注予定', receipt_plans: '入庫予定',
  schema_migrations: 'マイグレーション履歴',
};

// 各テーブルの「施設帰属」の求め方(施設別レコード数の集計用)。
//   direct  : 自テーブルの facility_id
//   product : product_id → products.facility_id
//   supplier: supplier_id → suppliers.facility_id
//   user    : user_id → users.facility_id
// ここに無いテーブル(施設共通/紐付け不能)は施設別集計の対象外とする。
const DIRECT   = ['products', 'product_details', 'suppliers', 'makers', 'departments', 'categories', 'users', 'app_settings', 'operation_logs'];
const VIA_PRODUCT  = ['barcodes', 'product_stocks', 'stock_movements', 'usage_records', 'receipt_details', 'issue_details', 'order_details'];
const VIA_SUPPLIER = ['orders', 'receipts'];
const VIA_USER     = ['issues'];

// テーブル名は上記の固定ホワイトリスト由来のみ(SQLインジェクション安全)
function facilityCountSql(table) {
  if (DIRECT.includes(table)) {
    return `SELECT facility_id AS fid, COUNT(*)::bigint AS c FROM ${table} GROUP BY facility_id`;
  }
  if (VIA_PRODUCT.includes(table)) {
    return `SELECT p.facility_id AS fid, COUNT(*)::bigint AS c FROM ${table} x JOIN products p ON p.id = x.product_id GROUP BY p.facility_id`;
  }
  if (VIA_SUPPLIER.includes(table)) {
    return `SELECT s.facility_id AS fid, COUNT(*)::bigint AS c FROM ${table} x JOIN suppliers s ON s.id = x.supplier_id GROUP BY s.facility_id`;
  }
  if (VIA_USER.includes(table)) {
    return `SELECT u.facility_id AS fid, COUNT(*)::bigint AS c FROM ${table} x JOIN users u ON u.id = x.user_id GROUP BY u.facility_id`;
  }
  return null;
}

// GET /api/db-usage
// DB全体サイズ、テーブル別サイズ/行数、施設別レコード数、施設一覧を返す。
router.get('/', async (req, res) => {
  try {
    const dbSize = await pool.query(`SELECT pg_database_size(current_database()) AS bytes`);
    const sizeRes = await pool.query(
      `SELECT c.relname AS name,
              pg_total_relation_size(c.oid) AS bytes,
              COALESCE(s.n_live_tup, 0)     AS rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC`
    );

    // 施設別レコード数(集計可能なテーブルのみ)
    const facilityable = [...DIRECT, ...VIA_PRODUCT, ...VIA_SUPPLIER, ...VIA_USER];
    const frResults = await Promise.all(
      facilityable.map((t) =>
        pool.query(facilityCountSql(t)).then((r) => [t, r.rows]).catch(() => [t, null])
      )
    );
    const facilityRowsByTable = {};
    for (const [t, rows] of frResults) {
      if (!rows) continue;
      const map = {};
      for (const row of rows) map[row.fid == null ? 'null' : String(row.fid)] = Number(row.c);
      facilityRowsByTable[t] = map;
    }

    const facilities = await pool.query(`SELECT id, name FROM facilities ORDER BY name`);

    const tables = sizeRes.rows.map((r) => ({
      name: r.name,
      label: TABLE_LABELS[r.name] || r.name,
      bytes: Number(r.bytes || 0),
      rows: Number(r.rows || 0),
      facilityRows: facilityRowsByTable[r.name] || null, // null=施設別集計対象外(施設共通)
    }));

    res.json({
      dbBytes: Number(dbSize.rows[0].bytes || 0),
      tables,
      facilities: facilities.rows.map((f) => ({ id: Number(f.id), name: f.name })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('DB使用量取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
