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

// 発注明細の予定数を、現在の order_plans(出庫寄与) から再計算する。
// order_plans が無ければ 0。未発注前提で order_quantity も予定数に同期する。
async function recalcOrderDetailPlan(client, orderDetailId) {
  const agg = await client.query(
    `SELECT COALESCE(SUM(issue_piece_quantity), 0) AS s, COUNT(*) AS c
       FROM order_plans WHERE order_detail_id = $1`,
    [orderDetailId]
  );
  const totalBara = Number(agg.rows[0].s);
  const cnt = Number(agg.rows[0].c);
  const pdq = await client.query(
    `SELECT COALESCE(pd.pack_size, 1) AS pack
       FROM order_details od LEFT JOIN product_details pd ON pd.id = od.product_detail_id
      WHERE od.id = $1`,
    [orderDetailId]
  );
  const pack = Math.max(1, Number(pdq.rows[0] ? pdq.rows[0].pack : 1) || 1);
  const planned = cnt === 0 ? 0 : Math.max(1, Math.ceil(totalBara / pack));
  await client.query(
    `UPDATE order_details SET planned_order_quantity = $1, order_quantity = $1 WHERE id = $2`,
    [planned, orderDetailId]
  );
  return planned;
}

// 入庫の巻き戻し(削除)。整合性を保てない場合は例外(status付き)を投げる。
async function reverseReceipt(client, receiptId, userId) {
  const head = await client.query(`SELECT * FROM receipts WHERE id = $1 FOR UPDATE`, [receiptId]);
  if (head.rowCount === 0) { const e = new Error('入庫が見つかりません'); e.status = 404; throw e; }
  const details = await client.query(
    `SELECT * FROM receipt_details WHERE receipt_id = $1`, [receiptId]
  );

  // ブロック条件1: この入庫のバーコードに使用済みがある
  const usedBc = await client.query(
    `SELECT COUNT(*) AS c FROM barcodes b
       JOIN receipt_details rd ON rd.id = b.receipt_detail_id
      WHERE rd.receipt_id = $1 AND b.voided_flag = FALSE AND b.used_flag = TRUE`,
    [receiptId]
  );
  if (Number(usedBc.rows[0].c) > 0) {
    const e = new Error('この入庫のバーコードは既に出庫されているため削除できません'); e.status = 400; throw e;
  }

  // 在庫の巻き戻し(減算)。不足するなら入庫分が既に消費済み → ブロック
  for (const d of details.rows) {
    try {
      await applyStockChange(client, {
        productId: d.product_id, lotNumber: d.lot_number || '', expiryDate: d.expiry_date,
        delta: -Number(d.stock_added_quantity), movementType: 'adjust',
        relatedId: receiptId, userId, reason: '入庫削除による取消', allowNegative: false,
      });
    } catch (err) {
      if (/在庫が不足/.test(err.message)) {
        const e = new Error('入庫分が既に出庫されているため削除できません'); e.status = 400; throw e;
      }
      throw err;
    }
  }

  // バーコードを論理削除(void)。値・連番を予約し再発行を防ぐ。
  await client.query(
    `UPDATE barcodes SET voided_flag = TRUE
      WHERE receipt_detail_id IN (SELECT id FROM receipt_details WHERE receipt_id = $1)
        AND voided_flag = FALSE`,
    [receiptId]
  );

  // 入庫予定(receipt_plans)を削除し、関連発注の入庫済み判定を巻き戻す
  const affected = await client.query(
    `SELECT DISTINCT od.order_id
       FROM receipt_plans rp
       JOIN order_details od ON od.id = rp.order_detail_id
      WHERE rp.receipt_detail_id IN (SELECT id FROM receipt_details WHERE receipt_id = $1)`,
    [receiptId]
  );
  await client.query(
    `DELETE FROM receipt_plans
      WHERE receipt_detail_id IN (SELECT id FROM receipt_details WHERE receipt_id = $1)`,
    [receiptId]
  );
  for (const row of affected.rows) {
    const still = await refreshOrderReceiptStatus(client, row.order_id);
    if (!still) {
      // 入庫済み条件を満たさなくなったら ordered に戻す
      await client.query(
        `UPDATE orders SET order_status = 'ordered'
          WHERE id = $1 AND order_status = 'received'`,
        [row.order_id]
      );
    }
  }

  await client.query(`DELETE FROM receipt_details WHERE receipt_id = $1`, [receiptId]);
  await client.query(`DELETE FROM receipts WHERE id = $1`, [receiptId]);
}

// 出庫の巻き戻し(削除)。整合性を保てない場合は例外(status付き)を投げる。
async function reverseIssue(client, issueId, userId) {
  const head = await client.query(`SELECT * FROM issues WHERE id = $1 FOR UPDATE`, [issueId]);
  if (head.rowCount === 0) { const e = new Error('出庫が見つかりません'); e.status = 404; throw e; }
  const details = await client.query(`SELECT * FROM issue_details WHERE issue_id = $1`, [issueId]);

  // ブロック条件: この出庫が寄与した発注が発注済み/入庫済み
  const ordered = await client.query(
    `SELECT COUNT(*) AS c
       FROM order_plans op
       JOIN order_details od ON od.id = op.order_detail_id
       JOIN orders o ON o.id = od.order_id
      WHERE op.issue_detail_id IN (SELECT id FROM issue_details WHERE issue_id = $1)
        AND o.order_status IN ('ordered', 'received')`,
    [issueId]
  );
  if (Number(ordered.rows[0].c) > 0) {
    const e = new Error('この出庫は既に発注に反映されているため削除できません（先に該当の発注を取消してください）');
    e.status = 400; throw e;
  }

  // 在庫を戻す(加算)
  for (const d of details.rows) {
    await applyStockChange(client, {
      productId: d.product_id, lotNumber: d.lot_number || '', expiryDate: d.expiry_date,
      delta: Number(d.issue_total_quantity), movementType: 'adjust',
      relatedId: issueId, userId, reason: '出庫削除による取消', allowNegative: true,
    });
  }

  // バーコード出庫分を未使用へ復元
  const barcodeIds = details.rows.map((d) => d.barcode_id).filter((x) => x != null);
  if (barcodeIds.length) {
    await client.query(
      `UPDATE barcodes SET used_flag = FALSE, use_start_date = NULL, use_end_date = NULL
        WHERE id = ANY($1::bigint[])`,
      [barcodeIds]
    );
  }

  // 使用記録(非バーコードの試薬管理対象)を削除
  await client.query(`DELETE FROM usage_records WHERE issue_id = $1`, [issueId]);

  // 発注予定(order_plans)を削除し、対象の発注明細の予定数を再計算
  const affectedOd = await client.query(
    `SELECT DISTINCT order_detail_id FROM order_plans
      WHERE issue_detail_id IN (SELECT id FROM issue_details WHERE issue_id = $1)`,
    [issueId]
  );
  await client.query(
    `DELETE FROM order_plans
      WHERE issue_detail_id IN (SELECT id FROM issue_details WHERE issue_id = $1)`,
    [issueId]
  );
  for (const row of affectedOd.rows) {
    await recalcOrderDetailPlan(client, row.order_detail_id);
  }

  await client.query(`DELETE FROM issue_details WHERE issue_id = $1`, [issueId]);
  await client.query(`DELETE FROM issues WHERE id = $1`, [issueId]);
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
  recalcOrderDetailPlan,
  reverseReceipt,
  reverseIssue,
};
