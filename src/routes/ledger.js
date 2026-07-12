'use strict';

const express = require('express');
const { pool } = require('../db');
const { sendCsv } = require('../services/csv');
const { writeLog } = require('../services/log');
const { facilityScope } = require('../services/facility');

const router = express.Router();

// 試薬管理台帳のデータ取得(ISO15189/医療法対応)
// 試薬管理対象商品で、入庫日～出庫日(使用開始日)が指定期間と重なるもの。
// ロットごとのトレーサビリティ(受入→開封→使用終了)に加え、メーカー・販売元・
// 保管場所・状態を出力し、精度管理・監査に使える台帳にする。
function buildLedgerQuery(q, scope) {
  const from = q.from || '0001-01-01';
  const to = q.to || '9999-12-31';
  const params = [from, to];
  let facCond = '';
  if (scope && !scope.all) { params.push(scope.facilityId); facCond = ` AND p.facility_id = $${params.length}`; }
  // 独自バーコード品(barcodes)と非バーコード品(usage_records)を統合して出力する。
  const sql =
    `SELECT *,
            CASE WHEN use_end_date   IS NOT NULL THEN '使用終了'
                 WHEN use_start_date IS NOT NULL THEN '使用中'
                 ELSE '未開封' END AS status
       FROM (
       -- 独自バーコード品
       SELECT r.receipt_date, p.name AS product_name,
              mk.name AS maker, sup.name AS supplier, sh.name AS shelf,
              rd.lot_number, b.content_code, rd.expiry_date,
              b.use_start_date, b.use_end_date
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
         JOIN receipts r ON r.id = rd.receipt_id
         LEFT JOIN product_details pd ON pd.id = rd.product_detail_id
         LEFT JOIN makers mk ON mk.id = pd.maker_id
         LEFT JOIN suppliers sup ON sup.id = COALESCE(pd.supplier_id, r.supplier_id)
         LEFT JOIN shelves sh ON sh.id = p.shelf_id
        WHERE p.qc_target_flag = TRUE
          AND b.voided_flag = FALSE
          AND r.receipt_date <= $2
          AND COALESCE(b.use_start_date, DATE '9999-12-31') >= $1${facCond}
       UNION ALL
       -- 非バーコード品(使用記録)。入庫日は保持しないため使用開始日を代替表示。
       -- メーカー・販売元は現行の商品詳細から補完する。
       SELECT u.use_start_date AS receipt_date, p.name AS product_name,
              mk.name AS maker, sup.name AS supplier, sh.name AS shelf,
              u.lot_number, u.content_code, u.expiry_date,
              u.use_start_date, u.use_end_date
         FROM usage_records u
         JOIN products p ON p.id = u.product_id
         LEFT JOIN LATERAL (
            SELECT pd.maker_id, pd.supplier_id FROM product_details pd
             WHERE pd.product_id = p.id
             ORDER BY (pd.apply_start_date <= CURRENT_DATE
                       AND (pd.apply_end_date IS NULL OR pd.apply_end_date >= CURRENT_DATE)) DESC,
                      pd.apply_start_date DESC
             LIMIT 1
         ) cpd ON TRUE
         LEFT JOIN makers mk ON mk.id = cpd.maker_id
         LEFT JOIN suppliers sup ON sup.id = cpd.supplier_id
         LEFT JOIN shelves sh ON sh.id = p.shelf_id
        WHERE p.qc_target_flag = TRUE
          AND u.use_start_date <= $2
          AND u.use_start_date >= $1${facCond}
     ) t
     ORDER BY receipt_date, product_name, content_code`;
  return { sql, params };
}

// 台帳データ(JSON)
router.get('/', async (req, res) => {
  try {
    const { sql, params } = buildLedgerQuery(req.query, facilityScope(req));
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
    const { sql, params } = buildLedgerQuery(req.query, facilityScope(req));
    const { rows } = await pool.query(sql, params);
    const columns = [
      { key: 'receipt_date', label: '入庫日' },
      { key: 'product_name', label: '商品名' },
      { key: 'maker', label: 'メーカー' },
      { key: 'supplier', label: '販売元' },
      { key: 'shelf', label: '保管場所' },
      { key: 'lot_number', label: 'ロット番号' },
      { key: 'content_code', label: '内容物コード' },
      { key: 'expiry_date', label: '有効期限' },
      { key: 'use_start_date', label: '使用開始日' },
      { key: 'use_end_date', label: '使用終了日' },
      { key: 'status', label: '状態' },
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
