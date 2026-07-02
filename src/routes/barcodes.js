'use strict';

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// 使用中(出庫済み・使用開始日あり・使用終了日未登録)の独自バーコード一覧
// GET /api/barcodes/in-use?query=
router.get('/in-use', async (req, res) => {
  const { query } = req.query;
  try {
    const params = [];
    let cond = 'b.used_flag = TRUE AND b.use_start_date IS NOT NULL AND b.use_end_date IS NULL';
    if (query) {
      params.push('%' + query + '%');
      cond += ` AND (b.barcode_value ILIKE $1 OR p.name ILIKE $1 OR CAST(b.content_code AS text) ILIKE $1)`;
    }
    const { rows } = await pool.query(
      `SELECT b.barcode_value, b.content_code, b.product_id, p.name AS product_name,
              rd.lot_number, rd.expiry_date, b.use_start_date
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
        WHERE ${cond}
        ORDER BY b.use_start_date, p.name`,
      params
    );
    res.json({ barcodes: rows });
  } catch (err) {
    console.error('使用中バーコード一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 使用終了日の登録/更新
// POST /api/barcodes/:value/use-end  body: { useEndDate }
router.post('/:value/use-end', async (req, res) => {
  const { useEndDate } = req.body || {};
  if (!useEndDate) return res.status(400).json({ error: '使用終了日は必須です' });
  try {
    const r = await pool.query(
      `UPDATE barcodes SET use_end_date = $1
        WHERE barcode_value = $2 AND used_flag = TRUE AND use_start_date IS NOT NULL
        RETURNING barcode_value, use_end_date`,
      [useEndDate, req.params.value]
    );
    if (r.rowCount === 0) {
      return res.status(400).json({ error: '対象のバーコードが見つからないか、使用開始されていません' });
    }
    res.json({ ok: true, barcode: r.rows[0] });
  } catch (err) {
    console.error('使用終了日登録エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
