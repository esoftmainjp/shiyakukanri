'use strict';

// 在庫・バーコード・発注予定に関する共通サービス。
// すべて呼び出し側のトランザクション(client)内で実行する前提。

// 'YYYY-MM-DD' → 'YYMMDD'
function toDateCode(dateStr) {
  const s = String(dateStr);
  return s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10);
}

// 在庫を増減し、在庫移動履歴を記録する。
// delta: 増加は正、減少は負(バラ個数)。allowNegative=false なら不足時に例外。
async function applyStockChange(client, {
  productId, lotNumber = '', expiryDate = null, delta,
  targetQuantity = null,
  movementType, relatedId = null, userId, reason = '',
  receiptDate = null, issueDate = null, allowNegative = false,
}) {
  // 対象在庫行をロック (使用期限NULLも IS NOT DISTINCT FROM で一致判定)
  const sel = await client.query(
    `SELECT id, stock_quantity FROM product_stocks
      WHERE product_id = $1 AND lot_number = $2
        AND expiry_date IS NOT DISTINCT FROM $3
      FOR UPDATE`,
    [productId, lotNumber, expiryDate]
  );

  const before = sel.rowCount ? Number(sel.rows[0].stock_quantity) : 0;
  // targetQuantity 指定時は絶対値調整 (delta = 目標 - 現在)
  const effectiveDelta = (targetQuantity !== null && targetQuantity !== undefined)
    ? Number(targetQuantity) - before
    : delta;
  const after = before + effectiveDelta;
  if (!allowNegative && after < 0) {
    const e = new Error('在庫が不足しています');
    e.status = 400;
    throw e;
  }

  if (sel.rowCount) {
    await client.query(
      `UPDATE product_stocks
          SET stock_quantity = $1,
              last_receipt_date = COALESCE($2, last_receipt_date),
              last_issue_date   = COALESCE($3, last_issue_date)
        WHERE id = $4`,
      [after, receiptDate, issueDate, sel.rows[0].id]
    );
  } else {
    await client.query(
      `INSERT INTO product_stocks
         (product_id, lot_number, expiry_date, stock_quantity,
          first_receipt_date, last_receipt_date, last_issue_date)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [productId, lotNumber, expiryDate, after, receiptDate, issueDate]
    );
  }

  await client.query(
    `INSERT INTO stock_movements
       (product_id, lot_number, expiry_date, movement_type,
        quantity_change, quantity_before, quantity_after,
        related_id, user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [productId, lotNumber, expiryDate, movementType,
     effectiveDelta, before, after, relatedId, userId, reason]
  );

  return { before, after, delta: effectiveDelta };
}

// 独自バーコードを quantity 本発行する(バラ1個=1本)。
// serial_number は日付単位、content_code は商品単位で採番する。
async function issueBarcodes(client, { receiptDetailId, productId, quantity, receiptDate }) {
  const dateCode = toDateCode(receiptDate);
  const s = await client.query(
    `SELECT COALESCE(MAX(serial_number), 0) AS m FROM barcodes WHERE date_code = $1`,
    [dateCode]
  );
  const c = await client.query(
    `SELECT COALESCE(MAX(content_code), 0) AS m FROM barcodes WHERE product_id = $1`,
    [productId]
  );
  let serial = Number(s.rows[0].m);
  let content = Number(c.rows[0].m);

  const created = [];
  for (let i = 0; i < quantity; i++) {
    serial += 1;
    content += 1;
    const value = dateCode + String(serial).padStart(4, '0');
    await client.query(
      `INSERT INTO barcodes
         (receipt_detail_id, product_id, barcode_value, issue_date,
          date_code, serial_number, content_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [receiptDetailId, productId, value, receiptDate, dateCode, serial, content]
    );
    created.push(value);
  }
  return created;
}

// 出庫明細から発注予定(中間テーブル)へ寄与を加算する。
// 未発注の発注情報/発注明細を問屋・商品単位で確保し、発注予定数を再計算する。
async function addOrderPlan(client, {
  issueDetailId, productId, productDetailId, supplierId, packSize, issuePieceQty, userId,
}) {
  // 未発注の発注情報を問屋単位で確保
  let orderId;
  const o = await client.query(
    `SELECT id FROM orders WHERE supplier_id = $1 AND order_status = 'unordered' ORDER BY id LIMIT 1`,
    [supplierId]
  );
  if (o.rowCount) {
    orderId = o.rows[0].id;
  } else {
    const ins = await client.query(
      `INSERT INTO orders (supplier_id, order_status, user_id) VALUES ($1, 'unordered', $2) RETURNING id`,
      [supplierId, userId]
    );
    orderId = ins.rows[0].id;
  }

  // 発注明細を商品単位で確保
  let orderDetailId;
  const d = await client.query(
    `SELECT id FROM order_details WHERE order_id = $1 AND product_id = $2 LIMIT 1`,
    [orderId, productId]
  );
  if (d.rowCount) {
    orderDetailId = d.rows[0].id;
  } else {
    const ins = await client.query(
      `INSERT INTO order_details (order_id, product_id, product_detail_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [orderId, productId, productDetailId]
    );
    orderDetailId = ins.rows[0].id;
  }

  // 中間テーブルに出庫バラ数を記録
  await client.query(
    `INSERT INTO order_plans (issue_detail_id, order_detail_id, issue_piece_quantity)
     VALUES ($1, $2, $3)`,
    [issueDetailId, orderDetailId, issuePieceQty]
  );

  // 発注予定数(梱包単位) = 出庫バラ累計 ÷ 梱包数 (切り上げ・最低1)
  const sum = await client.query(
    `SELECT COALESCE(SUM(issue_piece_quantity), 0) AS s FROM order_plans WHERE order_detail_id = $1`,
    [orderDetailId]
  );
  const totalBara = Number(sum.rows[0].s);
  const pack = Math.max(1, Number(packSize) || 1);
  const planned = Math.max(1, Math.ceil(totalBara / pack));

  // 未発注の間は発注個数も予定数に同期する
  await client.query(
    `UPDATE order_details SET planned_order_quantity = $1, order_quantity = $1 WHERE id = $2`,
    [planned, orderDetailId]
  );

  return { orderId, orderDetailId, plannedOrderQuantity: planned };
}

// 使用記録を count 件作成する(非バーコードの試薬管理対象品用)。
// 内容物コードは商品単位で採番。使用開始日=出庫日。
async function createUsageRecords(client, { productId, lotNumber = '', expiryDate = null, count, useStartDate, issueId = null }) {
  if (!count || count < 1) return 0;
  const c = await client.query(
    `SELECT COALESCE(MAX(content_code), 0) AS m FROM usage_records WHERE product_id = $1`,
    [productId]
  );
  let content = Number(c.rows[0].m);
  for (let i = 0; i < count; i++) {
    content += 1;
    await client.query(
      `INSERT INTO usage_records
         (product_id, lot_number, expiry_date, content_code, use_start_date, issue_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [productId, lotNumber, expiryDate, content, useStartDate, issueId]
    );
  }
  return count;
}

// 発注が全明細入庫済みかを判定し、満たしていれば発注状態を received にする。
async function refreshOrderReceiptStatus(client, orderId) {
  const details = await client.query(
    `SELECT od.id, od.order_quantity,
            COALESCE(pd.pack_size, 1) AS pack_size,
            COALESCE((SELECT SUM(rp.receipt_piece_quantity)
                        FROM receipt_plans rp WHERE rp.order_detail_id = od.id), 0) AS received_bara
       FROM order_details od
       LEFT JOIN product_details pd ON pd.id = od.product_detail_id
      WHERE od.order_id = $1`,
    [orderId]
  );
  if (details.rowCount === 0) return false;

  const allReceived = details.rows.every((r) => {
    const orderedBara = Number(r.order_quantity) * Number(r.pack_size);
    return Number(r.received_bara) >= orderedBara && orderedBara > 0;
  });

  if (allReceived) {
    await client.query(
      `UPDATE orders SET order_status = 'received' WHERE id = $1 AND order_status <> 'canceled'`,
      [orderId]
    );
  }
  return allReceived;
}

module.exports = {
  toDateCode,
  applyStockChange,
  issueBarcodes,
  addOrderPlan,
  createUsageRecords,
  refreshOrderReceiptStatus,
};
