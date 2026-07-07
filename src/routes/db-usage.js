'use strict';

// データベース使用量の詳細API (全体管理者=superadmin のみ。
// server.js で requireRole('superadmin') を適用)。
const express = require('express');
const { pool } = require('../db');
const { sendCsv } = require('../services/csv');

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

// DB使用量データを収集して返す(GET / と /csv で共用)。
async function gatherUsage() {
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

  return {
    dbBytes: Number(dbSize.rows[0].bytes || 0),
    tables,
    facilities: facilities.rows.map((f) => ({ id: Number(f.id), name: f.name })),
  };
}

// GET /api/db-usage
router.get('/', async (req, res) => {
  try {
    const data = await gatherUsage();
    res.json({ ...data, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('DB使用量取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// GET /api/db-usage/csv?metric=bytes|rows
// 施設×テーブルのマトリクス(1施設=1行、列=テーブル)。metric で値を切替:
//   bytes(容量) … 施設別はレコード数比による概算、施設共通は実容量
//   rows(件数)  … 施設別は正確なレコード数、施設共通は実件数
router.get('/csv', async (req, res) => {
  try {
    const metric = req.query.metric === 'rows' ? 'rows' : 'bytes';
    const { tables, facilities } = await gatherUsage();

    // 施設帰属テーブルの、その施設ぶんの値。容量は概算(容量×件数比)、件数は正確。
    const facVal = (t, key) => {
      if (!t.facilityRows) return 0;              // 施設共通は別行に計上
      const c = t.facilityRows[key] || 0;
      if (metric === 'rows') return c;
      return t.rows > 0 ? Math.round(t.bytes * c / t.rows) : 0;
    };
    // 施設共通テーブル(施設に紐づかない)の実値。
    const commonVal = (t) => (t.facilityRows ? 0 : (metric === 'rows' ? t.rows : t.bytes));

    // 列: 施設 + 各テーブル(容量の大きい順) + 合計
    const columns = [{ key: 'facility', label: '施設' }]
      .concat(tables.map((t) => ({ key: t.name, label: t.label })))
      .concat([{ key: '_total', label: '合計' }]);

    const dataRows = [];
    const pushRow = (facilityLabel, valueFn) => {
      const row = { facility: facilityLabel };
      let tot = 0;
      let any = false;
      for (const t of tables) {
        const v = valueFn(t);
        row[t.name] = v;
        tot += v;
        if (v) any = true;
      }
      row._total = tot;
      return { row, any };
    };

    // 施設ごと(1施設=1行)
    for (const f of facilities) {
      dataRows.push(pushRow(f.name, (t) => facVal(t, String(f.id))).row);
    }
    // 施設ID未割当(facility_id が NULL)の分
    const un = pushRow('未割当(施設ID無し)', (t) => facVal(t, 'null'));
    if (un.any) dataRows.push(un.row);
    // 施設共通(施設に紐づかないテーブル)
    const common = pushRow('施設共通', commonVal);
    if (common.any) dataRows.push(common.row);
    // 合計行(列ごとの合計)
    const totalRow = { facility: '合計' };
    let grand = 0;
    for (const t of tables) {
      const s = dataRows.reduce((a, r) => a + (r[t.name] || 0), 0);
      totalRow[t.name] = s;
      grand += s;
    }
    totalRow._total = grand;
    dataRows.push(totalRow);

    const fname = metric === 'rows' ? 'DB使用量_施設別件数.csv' : 'DB使用量_施設別容量.csv';
    sendCsv(res, fname, columns, dataRows);
  } catch (err) {
    console.error('DB使用量CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
