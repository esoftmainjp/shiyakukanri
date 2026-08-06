'use strict';

// データ一括エクスポート/バックアップ — 管理者以上限定(server.jsでガード)。
// 施設のマスタ・在庫・履歴を一括でCSV化しZIPにまとめてダウンロードする。
// 監査・システム移行・BCP(バックアップ)用途。

const express = require('express');
const { pool } = require('../db');
const { facilityScope } = require('../services/facility');
const { writeLog } = require('../services/log');
const { toCsv } = require('../services/csv');
const { buildZip } = require('../services/zip');

const router = express.Router();

// 出力対象。file=ZIP内CSV名 / table=列名取得元 / sql=施設スコープ済みSELECT($1=施設ID)。
const SPECS = [
  { file: 'departments',        table: 'departments',        sql: `SELECT * FROM departments WHERE facility_id = $1 ORDER BY id` },
  { file: 'categories',         table: 'categories',         sql: `SELECT * FROM categories WHERE facility_id = $1 ORDER BY id` },
  { file: 'shelves',            table: 'shelves',            sql: `SELECT * FROM shelves WHERE facility_id = $1 ORDER BY id` },
  { file: 'makers',             table: 'makers',             sql: `SELECT * FROM makers WHERE facility_id = $1 ORDER BY id` },
  { file: 'suppliers',          table: 'suppliers',          sql: `SELECT * FROM suppliers WHERE facility_id = $1 ORDER BY id` },
  { file: 'products',           table: 'products',           sql: `SELECT * FROM products WHERE facility_id = $1 ORDER BY id` },
  { file: 'product_details',    table: 'product_details',    sql: `SELECT * FROM product_details WHERE facility_id = $1 ORDER BY id` },
  { file: 'product_stocks',     table: 'product_stocks',     sql: `SELECT * FROM product_stocks WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'receipts',           table: 'receipts',           sql: `SELECT * FROM receipts r WHERE EXISTS (SELECT 1 FROM receipt_details rd JOIN products p ON p.id = rd.product_id WHERE rd.receipt_id = r.id AND p.facility_id = $1) ORDER BY id` },
  { file: 'receipt_details',    table: 'receipt_details',    sql: `SELECT * FROM receipt_details WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'issues',             table: 'issues',             sql: `SELECT * FROM issues i WHERE EXISTS (SELECT 1 FROM issue_details idt JOIN products p ON p.id = idt.product_id WHERE idt.issue_id = i.id AND p.facility_id = $1) ORDER BY id` },
  { file: 'issue_details',      table: 'issue_details',      sql: `SELECT * FROM issue_details WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'orders',             table: 'orders',             sql: `SELECT * FROM orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE facility_id = $1) ORDER BY id` },
  { file: 'order_details',      table: 'order_details',      sql: `SELECT * FROM order_details WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'stock_movements',    table: 'stock_movements',    sql: `SELECT * FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'barcodes',           table: 'barcodes',           sql: `SELECT * FROM barcodes WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'usage_records',      table: 'usage_records',      sql: `SELECT * FROM usage_records WHERE product_id IN (SELECT id FROM products WHERE facility_id = $1) ORDER BY id` },
  { file: 'supplier_bills',     table: 'supplier_bills',     sql: `SELECT * FROM supplier_bills WHERE facility_id = $1 ORDER BY id` },
  { file: 'supplier_bill_lines',table: 'supplier_bill_lines',sql: `SELECT * FROM supplier_bill_lines WHERE bill_id IN (SELECT id FROM supplier_bills WHERE facility_id = $1) ORDER BY id` },
  { file: 'stocktakes',         table: 'stocktakes',         sql: `SELECT * FROM stocktakes WHERE facility_id = $1 ORDER BY id` },
  { file: 'stocktake_lines',    table: 'stocktake_lines',    sql: `SELECT * FROM stocktake_lines WHERE stocktake_id IN (SELECT id FROM stocktakes WHERE facility_id = $1) ORDER BY id` },
  { file: 'users',              table: 'users',              sql: `SELECT * FROM users WHERE facility_id = $1 ORDER BY id` },
  { file: 'app_settings',       table: 'app_settings',       sql: `SELECT * FROM app_settings WHERE facility_id = $1 ORDER BY key` },
];

// 出力しない機密列(パスワード・トークン等)。全テーブル共通で除外する。
const SENSITIVE = /(password|secret|token|hash)/i;

async function columnsOf(table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map((x) => x.column_name).filter((c) => !SENSITIVE.test(c));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// GET /api/export/all — 施設の全データをZIP(複数CSV)で返す
router.get('/all', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '全体管理者は対象施設を選択してから実行してください' });
  const facilityId = scope.facilityId;
  try {
    const files = [];
    const summary = {};
    for (const spec of SPECS) {
      const cols = await columnsOf(spec.table);
      if (cols.length === 0) continue; // テーブル未作成(古いDB)はスキップ
      let rows = [];
      try {
        rows = (await pool.query(spec.sql, [facilityId])).rows;
      } catch (e) {
        if (e.code === '42P01') continue; // テーブル不在はスキップ
        throw e;
      }
      const columns = cols.map((c) => ({ key: c, label: c }));
      files.push({ name: spec.file + '.csv', data: toCsv(columns, rows) });
      summary[spec.file] = rows.length;
    }
    // 目録(何をいつ出力したか)
    const manifest = [
      '試薬在庫管理システム データエクスポート',
      '出力日時: ' + new Date().toISOString(),
      '施設ID: ' + facilityId,
      '',
      'ファイル一覧(件数):',
      ...files.map((f) => `  ${f.name}: ${summary[f.name.replace('.csv', '')]}件`),
    ].join('\r\n');
    files.push({ name: 'manifest.txt', data: manifest });

    const zip = buildZip(files);
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'app_settings', operationType: 'データエクスポート',
      after: { files: files.length, rows: summary },
    });
    const fname = `試薬在庫_バックアップ_${stamp()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="backup_${stamp()}.zip"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(zip);
  } catch (err) {
    console.error('データエクスポートエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
