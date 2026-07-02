'use strict';

const express = require('express');
const { getClient } = require('../db');
const { applyStockChange, issueBarcodes, refreshOrderReceiptStatus } = require('../services/inventory');
const { writeLog } = require('../services/log');

const router = express.Router();

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

module.exports = router;
