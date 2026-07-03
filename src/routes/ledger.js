'use strict';

const express = require('express');
const { pool } = require('../db');
const { sendCsv } = require('../services/csv');
const { writeLog } = require('../services/log');

const router = express.Router();

// 試薬管理台帳のデータ取得
// 試薬管理対象商品で、入庫日～出庫日(使用開始日)が指定期間と重なるもの。
function buildLedgerQuery(q) {
  const from = q.from || '0001-01-01';
  const to = q.to || '9999-12-31';
  // 独自バーコード品(barcodes)と非バーコード品(usage_records)を統合して出力する。
  const sql =
    `SELECT * FROM (
       -- 独自バーコード品
       SELECT r.receipt_date, p.name AS product_name,
              rd.lot_number, b.content_code, rd.expiry_date,
              b.use_start_date, b.use_end_date
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
         JOIN receipts r ON r.id = rd.receipt_id
        WHERE p.qc_target_flag = TRUE
          AND b.voided_flag = FALSE
          AND r.receipt_date <= $2
          AND COALESCE(b.use_start_date, DATE '9999-12-31') >= $1
       UNION ALL
       -- 非バーコード品(使用記録)。入庫日は保持しないため使用開始日を代替表示。
       SELECT u.use_start_date AS receipt_date, p.name AS product_name,
              u.lot_number, u.content_code, u.expiry_date,
              u.use_start_date, u.use_end_date
         FROM usage_records u
         JOIN products p ON p.id = u.product_id
        WHERE p.qc_target_flag = TRUE
          AND u.use_start_date <= $2
          AND u.use_start_date >= $1
     ) t
     ORDER BY receipt_date, product_name, content_code`;
  return { sql, params: [from, to] };
}

// 台帳データ(JSON)
router.get('/', async (req, res) => {
  try {
    const { sql, params } = buildLedgerQuery(req.query);
    const { rows } = await pool.query(sql, params);
    res.json({ rows });
  } catch (err) {
    console.error('試薬管理台帳エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 台帳CSV
router.get('/csv', async (req, res) => {
  try {
    const { sql, params } = buildLedgerQuery(req.query);
    const { rows } = await pool.query(sql, params);
    const columns = [
      { key: 'receipt_date', label: '入庫日' },
      { key: 'product_name', label: '商品名' },
      { key: 'lot_number', label: 'ロット番号' },
      { key: 'content_code', label: '内容物コード' },
      { key: 'expiry_date', label: '有効期限' },
      { key: 'use_start_date', label: '使用開始日' },
      { key: 'use_end_date', label: '使用終了日' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'ledger', operationType: 'CSV出力',
      after: { file: '試薬管理台帳.csv', from: req.query.from || null, to: req.query.to || null, count: rows.length },
    });
    sendCsv(res, '試薬管理台帳.csv', columns, rows);
  } catch (err) {
    console.error('試薬管理台帳CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
