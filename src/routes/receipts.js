'use strict';

const express = require('express');
const { pool, getClient } = require('../db');
const { applyStockChange, issueBarcodes, refreshOrderReceiptStatus, reverseReceipt } = require('../services/inventory');
const { writeLog } = require('../services/log');

const router = express.Router();

// 履歴の編集・削除は管理者/一般のみ(問屋は不可)
function requireEditor(req, res, next) {
  const t = req.session.user && req.session.user.userType;
  if (t === 'admin' || t === 'general') return next();
  return res.status(403).json({ error: 'この操作の権限がありません' });
}

// 入庫登録
// body: {
//   receiptDate, supplierId, orderId?, note?,
//   details: [{ productId, productDetailId, lotNumber?, expiryDate?,
//               receiptQuantity, packSize, unitPrice?,
//               orderDetailId?,  // 発注紐付け(部分入庫対応)
//               note? }]
// }
router.post('/', async (req, res) => {
  const userId = req.session.user.id;
  const { receiptDate, supplierId, orderId, note, details } = req.body || {};

  if (!receiptDate || !Array.isArray(details) || details.length === 0) {
    return res.status(400).json({ error: '入庫日と明細は必須です' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const rcpt = await client.query(
      `INSERT INTO receipts (receipt_date, supplier_id, user_id, order_id, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [receiptDate, supplierId || null, userId, orderId || null, note || '']
    );
    const receiptId = rcpt.rows[0].id;

    const affectedOrders = new Set();
    const resultDetails = [];

    for (const d of details) {
      if (!d.productId || !d.receiptQuantity || !d.packSize) {
        throw Object.assign(new Error('明細に商品ID・入庫個数・梱包数は必須です'), { status: 400 });
      }
      const lotNumber = d.lotNumber || '';
      const expiryDate = d.expiryDate || null;

      // 入庫明細 (在庫加算数は生成列で自動計算)
      const det = await client.query(
        `INSERT INTO receipt_details
           (receipt_id, product_id, product_detail_id, lot_number, expiry_date,
            receipt_quantity, pack_size, unit_price, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, stock_added_quantity`,
        [receiptId, d.productId, d.productDetailId || null, lotNumber, expiryDate,
         d.receiptQuantity, d.packSize, d.unitPrice || 0, d.note || '']
      );
      const receiptDetailId = det.rows[0].id;
      const addedBara = Number(det.rows[0].stock_added_quantity);

      // 在庫加算 + 在庫移動履歴
      const { after } = await applyStockChange(client, {
        productId: d.productId, lotNumber, expiryDate,
        delta: addedBara, movementType: 'receipt',
        relatedId: receiptId, userId, receiptDate,
      });

      // バーコード発行フラグを商品詳細から確認
      let barcodes = [];
      if (d.productDetailId) {
        const pd = await client.query(
          `SELECT barcode_issue_flag FROM product_details WHERE id = $1`,
          [d.productDetailId]
        );
        if (pd.rowCount && pd.rows[0].barcode_issue_flag) {
          barcodes = await issueBarcodes(client, {
            receiptDetailId, productId: d.productId, quantity: addedBara, receiptDate,
          });
        }
      }

      // 発注紐付け(入庫予定・部分入庫対応)
      if (d.orderDetailId) {
        await client.query(
          `INSERT INTO receipt_plans (order_detail_id, receipt_detail_id, receipt_piece_quantity)
           VALUES ($1, $2, $3)`,
          [d.orderDetailId, receiptDetailId, addedBara]
        );
        const od = await client.query(`SELECT order_id FROM order_details WHERE id = $1`, [d.orderDetailId]);
        if (od.rowCount) affectedOrders.add(od.rows[0].order_id);
      }

      resultDetails.push({
        receiptDetailId, addedBara, stockAfter: after, barcodesIssued: barcodes.length,
      });
    }

    // 関連発注の入庫済み判定
    const receivedOrders = [];
    for (const oid of affectedOrders) {
      const done = await refreshOrderReceiptStatus(client, oid);
      if (done) receivedOrders.push(oid);
    }

    await writeLog(client, {
      userId, targetTable: 'receipts', targetId: receiptId, operationType: '登録',
      after: { receiptDate, detailCount: resultDetails.length, receivedOrders },
    });

    await client.query('COMMIT');
    res.status(201).json({ receiptId, details: resultDetails, receivedOrders });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('入庫登録エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 入庫履歴一覧 (from/to/商品/キーワード)。明細件数・バラ合計・バーコード発行/使用状況を付与。
// GET /api/receipts?from=&to=&productId=&query=
router.get('/', async (req, res) => {
  const { from, to, productId, query } = req.query;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  try {
    const params = [];
    let cond = '1 = 1';
    if (from) { params.push(from); cond += ` AND r.receipt_date >= $${params.length}`; }
    if (to) { params.push(to); cond += ` AND r.receipt_date <= $${params.length}`; }
    if (productId) { params.push(productId); cond += ` AND EXISTS (SELECT 1 FROM receipt_details rd WHERE rd.receipt_id = r.id AND rd.product_id = $${params.length})`; }
    if (query) { params.push('%' + query + '%'); cond += ` AND (r.note ILIKE $${params.length} OR EXISTS (SELECT 1 FROM receipt_details rd JOIN products p ON p.id = rd.product_id WHERE rd.receipt_id = r.id AND p.name ILIKE $${params.length}))`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT r.id, r.receipt_date, r.supplier_id, s.name AS supplier_name, r.note, r.created_at,
              u.name AS user_name,
              (SELECT COUNT(*) FROM receipt_details rd WHERE rd.receipt_id = r.id) AS detail_count,
              (SELECT COALESCE(SUM(rd.stock_added_quantity), 0) FROM receipt_details rd WHERE rd.receipt_id = r.id) AS total_bara,
              (SELECT COUNT(*) FROM barcodes b JOIN receipt_details rd ON rd.id = b.receipt_detail_id
                WHERE rd.receipt_id = r.id AND b.voided_flag = FALSE) AS barcode_count,
              (SELECT COUNT(*) FROM barcodes b JOIN receipt_details rd ON rd.id = b.receipt_detail_id
                WHERE rd.receipt_id = r.id AND b.voided_flag = FALSE AND b.used_flag = TRUE) AS barcode_used_count
         FROM receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE ${cond}
        ORDER BY r.id DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ receipts: rows });
  } catch (err) {
    console.error('入庫履歴エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 入庫明細
// GET /api/receipts/:id
router.get('/:id', async (req, res) => {
  try {
    const head = await pool.query(
      `SELECT r.id, r.receipt_date, r.supplier_id, s.name AS supplier_name, r.note,
              r.created_at, u.name AS user_name
         FROM receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = $1`,
      [req.params.id]
    );
    if (head.rowCount === 0) return res.status(404).json({ error: '入庫が見つかりません' });
    const details = await pool.query(
      `SELECT rd.id, rd.product_id, p.name AS product_name, rd.product_detail_id,
              rd.lot_number, rd.expiry_date, rd.receipt_quantity, rd.pack_size,
              rd.stock_added_quantity, rd.note,
              (SELECT COUNT(*) FROM barcodes b WHERE b.receipt_detail_id = rd.id AND b.voided_flag = FALSE) AS barcode_count,
              (SELECT COUNT(*) FROM barcodes b WHERE b.receipt_detail_id = rd.id AND b.voided_flag = FALSE AND b.used_flag = TRUE) AS barcode_used_count
         FROM receipt_details rd
         JOIN products p ON p.id = rd.product_id
        WHERE rd.receipt_id = $1
        ORDER BY rd.id`,
      [req.params.id]
    );
    res.json({ receipt: head.rows[0], details: details.rows });
  } catch (err) {
    console.error('入庫明細エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 入庫の編集(備考・入庫日のみ)
// PATCH /api/receipts/:id  body: { note?, receiptDate? }
router.patch('/:id', requireEditor, async (req, res) => {
  const { note, receiptDate } = req.body || {};
  try {
    const cur = await pool.query(`SELECT id, receipt_date, note FROM receipts WHERE id = $1`, [req.params.id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '入庫が見つかりません' });

    // 入庫日変更はバーコード発行がある入庫では不可(バーコード値に発行日が埋め込まれるため)
    if (receiptDate && receiptDate !== cur.rows[0].receipt_date) {
      const bc = await pool.query(
        `SELECT COUNT(*) AS c FROM barcodes b JOIN receipt_details rd ON rd.id = b.receipt_detail_id
          WHERE rd.receipt_id = $1 AND b.voided_flag = FALSE`,
        [req.params.id]
      );
      if (Number(bc.rows[0].c) > 0) {
        return res.status(400).json({ error: 'バーコード発行済みの入庫は入庫日を変更できません（取消して再登録してください）' });
      }
    }
    const newDate = receiptDate || cur.rows[0].receipt_date;
    const newNote = note != null ? note : cur.rows[0].note;
    await pool.query(`UPDATE receipts SET receipt_date = $1, note = $2 WHERE id = $3`, [newDate, newNote, req.params.id]);
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'receipts', targetId: req.params.id, operationType: '更新',
      before: { receipt_date: cur.rows[0].receipt_date, note: cur.rows[0].note },
      after: { receipt_date: newDate, note: newNote },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('入庫編集エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 入庫の削除(巻き戻し)
// DELETE /api/receipts/:id
router.delete('/:id', requireEditor, async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const before = await client.query(`SELECT receipt_date, note FROM receipts WHERE id = $1`, [req.params.id]);
    await reverseReceipt(client, req.params.id, req.session.user.id);
    await writeLog(client, {
      userId: req.session.user.id, targetTable: 'receipts', targetId: req.params.id, operationType: '削除',
      before: before.rows[0] || null,
    });
    await client.query('COMMIT');
    res.json({ ok: true, message: '入庫を削除しました（在庫・バーコードを巻き戻しました）' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('入庫削除エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
