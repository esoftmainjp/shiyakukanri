'use strict';

// 問屋精算(支払/請求)の集計サービス。
// 入庫(receipt_details)＝買掛、返品(stock_movements return, 金額あり)＝控除。
// 既に確定(confirmed/paid)済みの source は除外(未精算分のみ)。

// 対象明細を集める。db は pool か tx client。
async function collectBillables(db, { facilityId, supplierId, from, to }) {
  const receipts = await db.query(
    `SELECT rd.id AS source_id, rd.product_id, p.name AS product_name,
            r.receipt_date AS event_date, rd.receipt_quantity AS quantity,
            rd.unit_price, (rd.receipt_quantity * rd.unit_price) AS amount
       FROM receipt_details rd
       JOIN receipts r ON r.id = rd.receipt_id
       JOIN products p ON p.id = rd.product_id
      WHERE r.supplier_id = $1 AND p.facility_id = $2
        AND r.receipt_date >= $3 AND r.receipt_date <= $4
        AND NOT EXISTS (SELECT 1 FROM supplier_bill_lines bl JOIN supplier_bills b ON b.id = bl.bill_id
                         WHERE bl.source_type = 'receipt' AND bl.source_id = rd.id
                           AND b.status IN ('confirmed','paid'))
      ORDER BY r.receipt_date, rd.id`,
    [supplierId, facilityId, from, to]
  );
  const returns = await db.query(
    `SELECT m.id AS source_id, m.product_id, p.name AS product_name,
            COALESCE(m.movement_date, m.created_at::date) AS event_date, (-m.quantity_input) AS quantity,
            m.unit_price, (-(m.quantity_input * m.unit_price)) AS amount
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
      WHERE m.movement_type = 'return' AND m.supplier_id = $1 AND p.facility_id = $2
        AND m.supplier_id IS NOT NULL AND m.unit_price IS NOT NULL AND m.quantity_input IS NOT NULL
        AND COALESCE(m.movement_date, m.created_at::date) >= $3
        AND COALESCE(m.movement_date, m.created_at::date) <= $4
        AND NOT EXISTS (SELECT 1 FROM supplier_bill_lines bl JOIN supplier_bills b ON b.id = bl.bill_id
                         WHERE bl.source_type = 'return' AND bl.source_id = m.id
                           AND b.status IN ('confirmed','paid'))
      ORDER BY COALESCE(m.movement_date, m.created_at::date), m.id`,
    [supplierId, facilityId, from, to]
  );
  const receiptLines = receipts.rows.map((r) => ({ ...r, source_type: 'receipt' }));
  const returnLines = returns.rows.map((r) => ({ ...r, source_type: 'return' }));
  const subtotal = [...receiptLines, ...returnLines].reduce((s, l) => s + Number(l.amount), 0);
  return { receiptLines, returnLines, subtotal };
}

// 税額(円未満切り捨て)と税込合計。合算後に1回だけ丸める。
function computeTax(subtotal, rate) {
  const sub = Number(subtotal) || 0;
  const tax = Math.floor(sub * (Number(rate) || 0) / 100);
  return { subtotal: sub, tax, total: sub + tax };
}

// 請求番号 YYYYMM-連番(施設内)。
async function nextBillNumber(db, facilityId, dateStr) {
  const ym = String(dateStr).slice(0, 7).replace('-', ''); // YYYYMM
  const r = await db.query(
    `SELECT COUNT(*) AS c FROM supplier_bills WHERE facility_id = $1 AND bill_number LIKE $2`,
    [facilityId, ym + '-%']
  );
  const seq = Number(r.rows[0].c) + 1;
  return `${ym}-${String(seq).padStart(4, '0')}`;
}

module.exports = { collectBillables, computeTax, nextBillNumber };
