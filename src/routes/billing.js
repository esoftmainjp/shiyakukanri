'use strict';

// 問屋精算(支払/請求)API。admin/superadmin、requireFeature('feat_billing')。
const express = require('express');
const { pool, getClient } = require('../db');
const { sendCsv } = require('../services/csv');
const { writeLog } = require('../services/log');
const { facilityScope } = require('../services/facility');
const { getSetting } = require('./settings');
const { collectBillables, computeTax, nextBillNumber } = require('../services/billing');

const router = express.Router();

const STATUS_LABEL = { draft: '未確定', confirmed: '確定', paid: '支払済', canceled: '取消' };

function requireFacilitySel(req, res) {
  const scope = facilityScope(req);
  if (scope.all || scope.facilityId == null) { res.status(400).json({ error: '対象施設を選択してください' }); return null; }
  return scope;
}
async function loadBill(db, id, facilityId) {
  const r = await db.query('SELECT * FROM supplier_bills WHERE id = $1 AND facility_id = $2', [id, facilityId]);
  return r.rowCount ? r.rows[0] : null;
}

// 締め前プレビュー(未精算分のみ)
// GET /api/billing/preview?supplierId&from&to
router.get('/preview', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  const { supplierId, from, to } = req.query;
  if (!supplierId || !from || !to) return res.status(400).json({ error: '問屋・期間(from/to)は必須です' });
  try {
    const { receiptLines, returnLines, subtotal } = await collectBillables(pool, { facilityId: scope.facilityId, supplierId, from, to });
    const rate = Number(await getSetting('tax_rate', '10', scope.facilityId)) || 0;
    const { tax, total } = computeTax(subtotal, rate);
    res.json({ lines: [...receiptLines, ...returnLines], subtotal, taxRate: rate, tax, total, count: receiptLines.length + returnLines.length });
  } catch (err) {
    console.error('請求プレビューエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 締め確定
// POST /api/billing/confirm  { supplierId, from, to, closingDate?, note? }
router.post('/confirm', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  const userId = req.session.user.id;
  const { supplierId, from, to, closingDate = null, note = '' } = req.body || {};
  if (!supplierId || !from || !to) return res.status(400).json({ error: '問屋・期間(from/to)は必須です' });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // 問屋が操作施設のものか
    const sc = await client.query('SELECT 1 FROM suppliers WHERE id = $1 AND facility_id = $2', [supplierId, scope.facilityId]);
    if (sc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '対象施設の問屋を指定してください' }); }

    const { receiptLines, returnLines, subtotal } = await collectBillables(client, { facilityId: scope.facilityId, supplierId, from, to });
    const lines = [...receiptLines, ...returnLines];
    if (lines.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '対象期間に未精算の取引がありません' }); }

    const rate = Number(await getSetting('tax_rate', '10', scope.facilityId)) || 0;
    const { tax, total } = computeTax(subtotal, rate);
    const billNo = await nextBillNumber(client, scope.facilityId, closingDate || to);

    const head = await client.query(
      `INSERT INTO supplier_bills
         (facility_id, supplier_id, bill_number, period_from, period_to, closing_date,
          subtotal, tax_rate, tax_amount, total_amount, status, note, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11,$12, now()) RETURNING id`,
      [scope.facilityId, supplierId, billNo, from, to, closingDate, subtotal, rate, tax, total, note, userId]
    );
    const billId = head.rows[0].id;
    for (const l of lines) {
      // 一意制約(source_type,source_id)違反=他で確定済み → 409
      await client.query(
        `INSERT INTO supplier_bill_lines (bill_id, source_type, source_id, product_id, event_date, quantity, unit_price, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [billId, l.source_type, l.source_id, l.product_id, l.event_date, l.quantity, l.unit_price, l.amount]
      );
    }
    await writeLog(client, {
      userId, targetTable: 'supplier_bills', targetId: billId, operationType: '登録',
      after: { bill_number: billNo, supplier_id: supplierId, subtotal, tax, total, count: lines.length },
      facilityId: scope.facilityId,
    });
    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: billId, billNumber: billNo, subtotal, tax, total });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: '対象の取引が別の支払で締め済みです。プレビューし直してください。' });
    }
    console.error('請求締めエラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 一覧CSV(先に定義: /:id より前)
router.get('/csv', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  try {
    const rows = await listBills(scope.facilityId, req.query);
    const data = rows.map((b) => ({
      bill_number: b.bill_number, supplier: b.supplier_name,
      period: `${b.period_from}〜${b.period_to}`, subtotal: b.subtotal,
      tax: b.tax_amount, total: b.total_amount, status: STATUS_LABEL[b.status] || b.status,
    }));
    sendCsv(res, '問屋支払一覧.csv', [
      { key: 'bill_number', label: '支払番号' }, { key: 'supplier', label: '問屋' },
      { key: 'period', label: '期間' }, { key: 'subtotal', label: '税抜小計' },
      { key: 'tax', label: '消費税' }, { key: 'total', label: '税込合計' }, { key: 'status', label: '状態' },
    ], data);
  } catch (err) {
    console.error('請求一覧CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

async function listBills(facilityId, q) {
  const params = [facilityId];
  const conds = ['b.facility_id = $1'];
  const add = (frag, val) => { params.push(val); conds.push(frag.replace('$$', '$' + params.length)); };
  if (q.supplierId) add('b.supplier_id = $$', q.supplierId);
  if (q.status) add('b.status = $$', q.status);
  if (q.from) add('b.period_to >= $$', q.from);
  if (q.to) add('b.period_from <= $$', q.to);
  const { rows } = await pool.query(
    `SELECT b.*, s.name AS supplier_name
       FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
      WHERE ${conds.join(' AND ')}
      ORDER BY b.id DESC`,
    params
  );
  return rows;
}

// 一覧
router.get('/', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  try {
    res.json({ bills: await listBills(scope.facilityId, req.query) });
  } catch (err) {
    console.error('請求一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 明細取得
router.get('/:id', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  try {
    const bill = await loadBill(pool, req.params.id, scope.facilityId);
    if (!bill) return res.status(404).json({ error: '支払が見つかりません' });
    const sup = await pool.query('SELECT name FROM suppliers WHERE id = $1', [bill.supplier_id]);
    const lines = await pool.query(
      `SELECT bl.*, p.name AS product_name FROM supplier_bill_lines bl
         LEFT JOIN products p ON p.id = bl.product_id
        WHERE bl.bill_id = $1 ORDER BY bl.event_date, bl.id`,
      [bill.id]
    );
    res.json({ bill: { ...bill, supplier_name: sup.rowCount ? sup.rows[0].name : '' }, lines: lines.rows });
  } catch (err) {
    console.error('請求明細エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 明細CSV
router.get('/:id/csv', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  try {
    const bill = await loadBill(pool, req.params.id, scope.facilityId);
    if (!bill) return res.status(404).json({ error: '支払が見つかりません' });
    const lines = await pool.query(
      `SELECT bl.event_date, bl.source_type, p.name AS product_name, bl.quantity, bl.unit_price, bl.amount
         FROM supplier_bill_lines bl LEFT JOIN products p ON p.id = bl.product_id
        WHERE bl.bill_id = $1 ORDER BY bl.event_date, bl.id`,
      [bill.id]
    );
    const data = lines.rows.map((l) => ({
      event_date: l.event_date || '', kind: l.source_type === 'return' ? '返品' : '入庫',
      product_name: l.product_name || '', quantity: l.quantity, unit_price: l.unit_price, amount: l.amount,
    }));
    sendCsv(res, `問屋支払_${bill.bill_number}.csv`, [
      { key: 'event_date', label: '日付' }, { key: 'kind', label: '種別' },
      { key: 'product_name', label: '商品' }, { key: 'quantity', label: '数量' },
      { key: 'unit_price', label: '単価' }, { key: 'amount', label: '金額' },
    ], data);
  } catch (err) {
    console.error('請求明細CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 入金済み
router.post('/:id/paid', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  try {
    const bill = await loadBill(pool, req.params.id, scope.facilityId);
    if (!bill) return res.status(404).json({ error: '支払が見つかりません' });
    if (bill.status !== 'confirmed') return res.status(409).json({ error: '確定済みの支払のみ支払済にできます' });
    await pool.query(`UPDATE supplier_bills SET status = 'paid', paid_at = now() WHERE id = $1`, [bill.id]);
    await writeLog(pool, { userId: req.session.user.id, targetTable: 'supplier_bills', targetId: bill.id, operationType: '更新', after: { status: 'paid' }, facilityId: scope.facilityId });
    res.json({ ok: true });
  } catch (err) {
    console.error('入金更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 取消(明細削除でsource解放)
router.post('/:id/cancel', async (req, res) => {
  const scope = requireFacilitySel(req, res); if (!scope) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const bill = await loadBill(client, req.params.id, scope.facilityId);
    if (!bill) { await client.query('ROLLBACK'); return res.status(404).json({ error: '支払が見つかりません' }); }
    if (!['confirmed', 'paid'].includes(bill.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'この支払は取消できません' }); }
    await client.query('DELETE FROM supplier_bill_lines WHERE bill_id = $1', [bill.id]); // source解放
    await client.query(`UPDATE supplier_bills SET status = 'canceled', canceled_at = now() WHERE id = $1`, [bill.id]);
    await writeLog(client, { userId: req.session.user.id, targetTable: 'supplier_bills', targetId: bill.id, operationType: '取消', before: { status: bill.status }, after: { status: 'canceled' }, facilityId: scope.facilityId });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('請求取消エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
