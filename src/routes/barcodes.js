'use strict';

const express = require('express');
const { pool } = require('../db');
const { writeLog } = require('../services/log');

const router = express.Router();

// 発行済み独自バーコードの一覧(印刷用)
// フィルタ: from/to(発行日) / productId / query(バーコード値・商品名の部分一致)
router.get('/list', async (req, res) => {
  const { from, to, productId, query, receiptId } = req.query;
  const includePrinted = String(req.query.includePrinted) === 'true';
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  try {
    const params = [];
    let cond = 'b.voided_flag = FALSE';
    // 既定は未印刷のみ。receiptId指定(入庫時の初回印刷)またはincludePrinted時は印刷済みも含める
    if (!receiptId && !includePrinted) cond += ' AND b.printed_flag = FALSE';
    if (from) { params.push(from); cond += ` AND b.issue_date >= $${params.length}`; }
    if (to) { params.push(to); cond += ` AND b.issue_date <= $${params.length}`; }
    if (productId) { params.push(productId); cond += ` AND b.product_id = $${params.length}`; }
    if (receiptId) { params.push(receiptId); cond += ` AND rd.receipt_id = $${params.length}`; }
    if (query) { params.push('%' + query + '%'); cond += ` AND (b.barcode_value ILIKE $${params.length} OR p.name ILIKE $${params.length})`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT b.barcode_value, b.content_code, b.product_id, p.name AS product_name,
              rd.lot_number, rd.expiry_date, b.issue_date, b.used_flag, b.printed_flag
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
        WHERE ${cond}
        ORDER BY b.issue_date DESC, p.name, b.content_code
        LIMIT $${params.length}`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('バーコード一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// バーコードを印刷済みにする
// POST /api/barcodes/mark-printed  body: { values: ["2607...", ...] }
router.post('/mark-printed', async (req, res) => {
  const values = (req.body && req.body.values) || [];
  if (!Array.isArray(values) || values.length === 0) return res.json({ ok: true, updated: 0 });
  try {
    const r = await pool.query(
      `UPDATE barcodes SET printed_flag = TRUE, printed_at = now()
        WHERE barcode_value = ANY($1::text[]) AND voided_flag = FALSE`,
      [values]
    );
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'barcodes', operationType: 'バーコード印刷',
      after: { count: r.rowCount, values: values.slice(0, 50) },
    });
    res.json({ ok: true, updated: r.rowCount });
  } catch (err) {
    console.error('印刷済み更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 使用中(使用開始済み・使用終了日未登録)の一覧
//  - 独自バーコード(barcodes): kind='barcode', key=バーコード値
//  - 使用記録(usage_records): kind='usage', key=id
// フィルタ: query(部分一致) / productId / lot
router.get('/in-use', async (req, res) => {
  const { query, productId, lot } = req.query;
  try {
    // 独自バーコード
    const bcParams = [];
    let bcCond = 'b.voided_flag = FALSE AND b.used_flag = TRUE AND b.use_start_date IS NOT NULL AND b.use_end_date IS NULL';
    if (query) { bcParams.push('%' + query + '%'); bcCond += ` AND (b.barcode_value ILIKE $${bcParams.length} OR p.name ILIKE $${bcParams.length} OR CAST(b.content_code AS text) ILIKE $${bcParams.length})`; }
    if (productId) { bcParams.push(productId); bcCond += ` AND b.product_id = $${bcParams.length}`; }
    if (lot) { bcParams.push(lot); bcCond += ` AND rd.lot_number = $${bcParams.length}`; }
    const bc = await pool.query(
      `SELECT 'barcode' AS kind, b.barcode_value AS key, b.content_code, b.product_id,
              p.name AS product_name, rd.lot_number, rd.expiry_date, b.use_start_date
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
        WHERE ${bcCond}
        ORDER BY b.use_start_date, p.name`,
      bcParams
    );

    // 使用記録
    const urParams = [];
    let urCond = 'u.use_end_date IS NULL';
    if (query) { urParams.push('%' + query + '%'); urCond += ` AND (p.name ILIKE $${urParams.length} OR CAST(u.content_code AS text) ILIKE $${urParams.length})`; }
    if (productId) { urParams.push(productId); urCond += ` AND u.product_id = $${urParams.length}`; }
    if (lot) { urParams.push(lot); urCond += ` AND u.lot_number = $${urParams.length}`; }
    // usage_records未作成(本番マイグレーション前)でもバーコード分は表示できるよう、
    // テーブル不在(42P01)の場合は空扱いにフォールバックする。
    let urRows = [];
    try {
      const ur = await pool.query(
        `SELECT 'usage' AS kind, u.id::text AS key, u.content_code, u.product_id,
                p.name AS product_name, u.lot_number, u.expiry_date, u.use_start_date
           FROM usage_records u
           JOIN products p ON p.id = u.product_id
          WHERE ${urCond}
          ORDER BY u.use_start_date, p.name`,
        urParams
      );
      urRows = ur.rows;
    } catch (e) {
      if (e.code === '42P01') {
        console.warn('usage_recordsテーブルが未作成です。マイグレーションを実行してください。');
      } else {
        throw e;
      }
    }

    res.json({ items: [...bc.rows, ...urRows] });
  } catch (err) {
    console.error('使用中一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 使用終了日の登録/更新 (kind と key で対象を指定)
// POST /api/barcodes/use-end  body: { kind, key, useEndDate }
router.post('/use-end', async (req, res) => {
  const { kind, key, useEndDate } = req.body || {};
  if (!kind || !key || !useEndDate) return res.status(400).json({ error: 'kind・key・使用終了日は必須です' });
  try {
    if (kind === 'barcode') {
      const r = await pool.query(
        `UPDATE barcodes SET use_end_date = $1
          WHERE barcode_value = $2 AND used_flag = TRUE AND use_start_date IS NOT NULL
          RETURNING barcode_value`,
        [useEndDate, key]
      );
      if (r.rowCount === 0) return res.status(400).json({ error: '対象の独自バーコードが見つかりません' });
    } else if (kind === 'usage') {
      const r = await pool.query(
        `UPDATE usage_records SET use_end_date = $1 WHERE id = $2 RETURNING id`,
        [useEndDate, key]
      );
      if (r.rowCount === 0) return res.status(400).json({ error: '対象の使用記録が見つかりません' });
    } else {
      return res.status(400).json({ error: '不明な種別です' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('使用終了日登録エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
