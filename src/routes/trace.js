'use strict';

// ロット逆引き(トレーサビリティ) — 管理者以上限定(server.jsでガード)。
// 指定ロット番号について、施設内の 現在庫 / 入庫 / 出庫 / 在庫移動 / 使用記録 を
// 横断的に逆引きし、該当ロットの入手元・使用先・現状を追跡する(リコール対応)。

const express = require('express');
const { pool } = require('../db');
const { facilityScope } = require('../services/facility');
const { sendCsv } = require('../services/csv');

const router = express.Router();

// 施設スコープ条件を組み立てる。返り値 { cond, params }。$1 は常にロット番号。
function scopeCond(lot, scope) {
  const params = [lot];
  let fac = '';
  if (!scope.all) { params.push(scope.facilityId); fac = ` AND p.facility_id = $${params.length}`; }
  return { params, fac };
}

const MOVE_LABEL = { receipt: '入庫', issue: '出庫', adjust: '在庫調整', disposal: '廃棄', return: '返品', stocktake: '棚卸差異' };

async function gather(lot, scope) {
  // 1. 現在庫
  const s1 = scopeCond(lot, scope);
  const currentStock = (await pool.query(
    `SELECT p.name AS product_name, sh.name AS shelf, s.expiry_date, s.stock_quantity
       FROM product_stocks s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN shelves sh ON sh.id = p.shelf_id
      WHERE s.lot_number = $1 AND s.stock_quantity > 0${s1.fac}
      ORDER BY p.name`, s1.params)).rows;

  // 2. 入庫
  const s2 = scopeCond(lot, scope);
  const receipts = (await pool.query(
    `SELECT r.receipt_date, p.name AS product_name, sup.name AS supplier,
            rd.receipt_quantity, rd.pack_size, rd.stock_added_quantity,
            rd.expiry_date, u.name AS user_name
       FROM receipt_details rd
       JOIN receipts r ON r.id = rd.receipt_id
       JOIN products p ON p.id = rd.product_id
       LEFT JOIN suppliers sup ON sup.id = r.supplier_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE rd.lot_number = $1${s2.fac}
      ORDER BY r.receipt_date, p.name`, s2.params)).rows;

  // 3. 出庫
  const s3 = scopeCond(lot, scope);
  const issues = (await pool.query(
    `SELECT i.issue_date, p.name AS product_name,
            idt.issue_quantity, idt.issue_total_quantity, idt.expiry_date,
            b.barcode_value, u.name AS user_name
       FROM issue_details idt
       JOIN issues i ON i.id = idt.issue_id
       JOIN products p ON p.id = idt.product_id
       LEFT JOIN barcodes b ON b.id = idt.barcode_id
       LEFT JOIN users u ON u.id = i.user_id
      WHERE idt.lot_number = $1${s3.fac}
      ORDER BY i.issue_date, p.name`, s3.params)).rows;

  // 4. 在庫移動履歴(入庫/出庫/調整/廃棄/返品/棚卸差異)
  const s4 = scopeCond(lot, scope);
  const movements = (await pool.query(
    `SELECT COALESCE(m.movement_date, m.created_at::date) AS movement_date,
            m.created_at, m.movement_type, p.name AS product_name,
            m.quantity_change, m.quantity_before, m.quantity_after,
            m.reason, u.name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.lot_number = $1${s4.fac}
      ORDER BY m.id`, s4.params)).rows;

  // 5. 使用記録(バーコード非発行品の開封/使用終了)
  const s5 = scopeCond(lot, scope);
  const usageRecords = (await pool.query(
    `SELECT p.name AS product_name, ur.content_code, ur.expiry_date,
            ur.use_start_date, ur.use_end_date
       FROM usage_records ur
       JOIN products p ON p.id = ur.product_id
      WHERE ur.lot_number = $1${s5.fac}
      ORDER BY ur.use_start_date`, s5.params)).rows;

  return { currentStock, receipts, issues, movements, usageRecords };
}

// GET /api/trace/lot?lot=... — ロット逆引き結果(JSON)
router.get('/lot', async (req, res) => {
  const lot = (req.query.lot || '').trim();
  if (!lot) return res.status(400).json({ error: 'ロット番号を指定してください' });
  try {
    const data = await gather(lot, facilityScope(req));
    res.json({ lot, ...data });
  } catch (err) {
    console.error('ロット逆引きエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// GET /api/trace/lot/csv?lot=... — 逆引き結果(在庫移動履歴)のCSV
router.get('/lot/csv', async (req, res) => {
  const lot = (req.query.lot || '').trim();
  if (!lot) return res.status(400).json({ error: 'ロット番号を指定してください' });
  try {
    const { movements } = await gather(lot, facilityScope(req));
    const data = movements.map((m) => ({
      movement_date: m.movement_date ? String(m.movement_date).slice(0, 10) : '',
      movement_type: MOVE_LABEL[m.movement_type] || m.movement_type,
      product_name: m.product_name,
      quantity_change: m.quantity_change,
      quantity_before: m.quantity_before,
      quantity_after: m.quantity_after,
      reason: m.reason,
      user_name: m.user_name || '',
    }));
    const columns = [
      { key: 'movement_date', label: '対象日' },
      { key: 'movement_type', label: '区分' },
      { key: 'product_name', label: '商品' },
      { key: 'quantity_change', label: '増減(バラ)' },
      { key: 'quantity_before', label: '変動前' },
      { key: 'quantity_after', label: '変動後' },
      { key: 'reason', label: '理由' },
      { key: 'user_name', label: '担当' },
    ];
    sendCsv(res, `ロット逆引き_${lot}.csv`, columns, data);
  } catch (err) {
    console.error('ロット逆引きCSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
