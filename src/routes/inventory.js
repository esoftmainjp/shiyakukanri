'use strict';

const express = require('express');
const { pool, getClient } = require('../db');
const { applyStockChange } = require('../services/inventory');
const { sendCsv } = require('../services/csv');
const { writeLog } = require('../services/log');
const { facilityScope } = require('../services/facility');

const router = express.Router();

// 在庫一覧の絞り込みクエリを構築 (施設スコープ: 商品の所属施設で限定)
function buildStockQuery(q, scope) {
  const where = [];
  const params = [];
  const add = (cond, val) => { params.push(val); where.push(cond.replace('$$', '$' + params.length)); };

  if (scope && !scope.all) add('p.facility_id = $$', scope.facilityId);
  if (q.departmentId) add('p.department_id = $$', q.departmentId);
  if (q.categoryId) add('p.category_id = $$', q.categoryId);
  if (q.productName) add('p.name ILIKE $$', '%' + q.productName + '%');
  if (q.note) add('p.note ILIKE $$', '%' + q.note + '%');
  if (q.lotNumber) add('s.lot_number ILIKE $$', '%' + q.lotNumber + '%');
  if (q.expiryFrom) add('s.expiry_date >= $$', q.expiryFrom);
  if (q.expiryTo) add('s.expiry_date <= $$', q.expiryTo);
  if (q.supplierId) add('EXISTS (SELECT 1 FROM product_details pd WHERE pd.product_id = p.id AND pd.supplier_id = $$)', q.supplierId);
  if (q.makerId) add('EXISTS (SELECT 1 FROM product_details pd WHERE pd.product_id = p.id AND pd.maker_id = $$)', q.makerId);
  if (String(q.includeZero) !== 'true') where.push('s.stock_quantity > 0');

  const sql =
    `SELECT s.id, p.id AS product_id, p.name AS product_name, sh.name AS shelf,
            d.name AS department, c.name AS category, p.note AS note,
            (SELECT string_agg(DISTINCT s2.name, ', ') FROM product_details pd2
               JOIN suppliers s2 ON s2.id = pd2.supplier_id WHERE pd2.product_id = p.id) AS supplier,
            (SELECT string_agg(DISTINCT m2.name, ', ') FROM product_details pd2
               JOIN makers m2 ON m2.id = pd2.maker_id WHERE pd2.product_id = p.id) AS maker,
            s.lot_number, s.expiry_date, s.stock_quantity,
            s.first_receipt_date, s.last_receipt_date, s.last_issue_date
       FROM product_stocks s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN shelves sh ON sh.id = p.shelf_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.name, s.expiry_date NULLS LAST`;
  return { sql, params };
}

// 在庫一覧
router.get('/', async (req, res) => {
  try {
    const { sql, params } = buildStockQuery(req.query, facilityScope(req));
    const { rows } = await pool.query(sql, params);
    res.json({ stocks: rows });
  } catch (err) {
    console.error('在庫一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 在庫一覧CSV
router.get('/csv', async (req, res) => {
  try {
    const { sql, params } = buildStockQuery(req.query, facilityScope(req));
    const { rows } = await pool.query(sql, params);
    const columns = [
      { key: 'product_name', label: '商品名' },
      { key: 'supplier', label: '問屋' },
      { key: 'maker', label: 'メーカー' },
      { key: 'department', label: '部門' },
      { key: 'category', label: '分類' },
      { key: 'shelf', label: '棚' },
      { key: 'lot_number', label: 'ロット番号' },
      { key: 'expiry_date', label: '使用期限' },
      { key: 'stock_quantity', label: '在庫数(バラ)' },
      { key: 'note', label: '備考' },
      { key: 'first_receipt_date', label: '初回入庫日' },
      { key: 'last_receipt_date', label: '最終入庫日' },
      { key: 'last_issue_date', label: '最終出庫日' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'inventory', operationType: 'CSV出力',
      after: { file: '在庫一覧.csv', count: rows.length },
    });
    sendCsv(res, '在庫一覧.csv', columns, rows);
  } catch (err) {
    console.error('在庫CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 使用期限管理: 期限切れ・期限接近の在庫一覧
// GET /api/inventory/expiry?warnDays=30
router.get('/expiry', async (req, res) => {
  try {
    const scope = facilityScope(req);
    let warnDays = parseInt(req.query.warnDays, 10);
    if (Number.isNaN(warnDays)) {
      const { rows } = await pool.query(
        `SELECT value FROM app_settings WHERE key = 'expiry_warn_days' AND facility_id IS NOT DISTINCT FROM $1`,
        [scope.all ? null : scope.facilityId]
      );
      warnDays = rows.length ? parseInt(rows[0].value, 10) : 30;
    }
    if (Number.isNaN(warnDays) || warnDays < 0) warnDays = 30;
    const params = [warnDays];
    let facCond = '';
    if (!scope.all) { params.push(scope.facilityId); facCond = ` AND p.facility_id = $${params.length}`; }
    // 有効警告日数 = 商品詳細の expiry_warn_days(0超) を優先、無ければ施設/既定の warnDays。
    // 商品詳細は「本日適用中」を優先し、無ければ最新の適用開始日のものを採用。
    const { rows } = await pool.query(
      `WITH base AS (
         SELECT s.id, p.id AS product_id, p.name AS product_name, sh.name AS shelf,
                s.lot_number, s.expiry_date, s.stock_quantity,
                (SELECT COALESCE(SUM(ps.stock_quantity), 0) FROM product_stocks ps WHERE ps.product_id = p.id) AS product_total,
                EXISTS (SELECT 1 FROM order_details od JOIN orders o ON o.id = od.order_id
                         WHERE od.product_id = p.id AND o.order_status = 'unordered'
                           AND od.canceled_flag = FALSE AND od.order_quantity > 0) AS has_order_plan,
                EXISTS (SELECT 1 FROM order_details od JOIN orders o ON o.id = od.order_id
                         LEFT JOIN product_details pd ON pd.id = od.product_detail_id
                         WHERE od.product_id = p.id AND o.order_status = 'ordered' AND od.canceled_flag = FALSE
                           AND (od.order_quantity * COALESCE(pd.pack_size, 1)
                                - COALESCE((SELECT SUM(rp.receipt_piece_quantity) FROM receipt_plans rp WHERE rp.order_detail_id = od.id), 0)) > 0
                       ) AS has_incoming,
                (s.expiry_date - CURRENT_DATE) AS days_left,
                COALESCE(NULLIF((
                   SELECT pd.expiry_warn_days FROM product_details pd
                    WHERE pd.product_id = p.id
                    ORDER BY (pd.apply_start_date <= CURRENT_DATE
                              AND (pd.apply_end_date IS NULL OR pd.apply_end_date >= CURRENT_DATE)) DESC,
                             pd.apply_start_date DESC
                    LIMIT 1), 0), $1) AS warn_days
           FROM product_stocks s
           JOIN products p ON p.id = s.product_id
           LEFT JOIN shelves sh ON sh.id = p.shelf_id
          WHERE s.stock_quantity > 0
            AND s.expiry_date IS NOT NULL${facCond}
       )
       SELECT *,
              CASE WHEN expiry_date < CURRENT_DATE THEN 'expired' ELSE 'warning' END AS status
         FROM base
        WHERE expiry_date <= CURRENT_DATE + (warn_days || ' days')::interval
        ORDER BY expiry_date`,
      params
    );
    res.json({ warnDays, rows });
  } catch (err) {
    console.error('使用期限管理エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 在庫調整・廃棄・返品などの在庫移動履歴
// GET /api/inventory/movements?from=&to=&productId=&type=
//   type未指定は手動調整系(adjust/disposal/return)を表示。receipt/issue等も個別指定可。
async function queryMovements(q, scope) {
  const { from, to, productId, type } = q;
  const limit = Math.min(Number(q.limit) || 500, 2000);
  const params = [];
  let cond;
  if (type && ['receipt', 'issue', 'adjust', 'disposal', 'return'].includes(type)) {
    params.push(type); cond = `m.movement_type = $${params.length}`;
  } else {
    cond = `m.movement_type IN ('adjust', 'disposal', 'return')`;
  }
  if (scope && !scope.all) { params.push(scope.facilityId); cond += ` AND p.facility_id = $${params.length}`; }
  if (from) { params.push(from); cond += ` AND COALESCE(m.movement_date, m.created_at::date) >= $${params.length}`; }
  if (to) { params.push(to); cond += ` AND COALESCE(m.movement_date, m.created_at::date) <= $${params.length}`; }
  if (productId) { params.push(productId); cond += ` AND m.product_id = $${params.length}`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT m.id, m.created_at,
            COALESCE(m.movement_date, m.created_at::date) AS movement_date,
            m.movement_type, m.product_id, p.name AS product_name,
            m.lot_number, m.expiry_date, m.quantity_change, m.quantity_before, m.quantity_after,
            m.reason, u.name AS user_name, m.related_id
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE ${cond}
      ORDER BY m.id DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

router.get('/movements', async (req, res) => {
  try {
    res.json({ movements: await queryMovements(req.query, facilityScope(req)) });
  } catch (err) {
    console.error('在庫移動履歴エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 在庫調整履歴CSV
// GET /api/inventory/movements/csv
const MOVE_LABEL = { receipt: '入庫', issue: '出庫', adjust: '在庫調整', disposal: '廃棄', return: '返品' };
router.get('/movements/csv', async (req, res) => {
  try {
    const rows = await queryMovements(req.query, facilityScope(req));
    const data = rows.map((m) => ({
      movement_date: m.movement_date ? String(m.movement_date).slice(0, 10) : '',
      created_at: m.created_at ? String(m.created_at).replace('T', ' ').slice(0, 19) : '',
      movement_type: MOVE_LABEL[m.movement_type] || m.movement_type,
      product_name: m.product_name,
      lot_number: m.lot_number,
      expiry_date: m.expiry_date,
      quantity_change: m.quantity_change,
      quantity_before: m.quantity_before,
      quantity_after: m.quantity_after,
      reason: m.reason,
      user_name: m.user_name || '',
    }));
    const columns = [
      { key: 'movement_date', label: '対象日' },
      { key: 'created_at', label: '登録日時' },
      { key: 'movement_type', label: '区分' },
      { key: 'product_name', label: '商品' },
      { key: 'lot_number', label: 'ロット' },
      { key: 'expiry_date', label: '使用期限' },
      { key: 'quantity_change', label: '増減(バラ)' },
      { key: 'quantity_before', label: '調整前' },
      { key: 'quantity_after', label: '調整後' },
      { key: 'reason', label: '理由' },
      { key: 'user_name', label: '担当' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'stock_movements', operationType: 'CSV出力',
      after: { file: '在庫調整履歴.csv', count: rows.length },
    });
    sendCsv(res, '在庫調整履歴.csv', columns, data);
  } catch (err) {
    console.error('在庫調整履歴CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 返品カードの既定値(そのロット＋期限の仕入=問屋・単価、梱包数)を返す。
// GET /api/inventory/return-default?productId=&lotNumber=&expiryDate=
router.get('/return-default', async (req, res) => {
  const scope = facilityScope(req);
  const { productId, lotNumber = '', expiryDate = null } = req.query;
  if (!productId) return res.status(400).json({ error: '商品IDが必要です' });
  try {
    if (!scope.all) {
      const chk = await pool.query('SELECT facility_id FROM products WHERE id = $1', [productId]);
      if (chk.rowCount === 0 || String(chk.rows[0].facility_id) !== String(scope.facilityId)) {
        return res.status(404).json({ error: '対象の商品が見つかりません' });
      }
    }
    let supplierId = null, unitPrice = null, packSize = 1;
    const pd = await pool.query('SELECT pack_size, unit_price, supplier_id FROM product_details WHERE product_id = $1 ORDER BY apply_start_date DESC LIMIT 1', [productId]);
    if (pd.rowCount) packSize = Number(pd.rows[0].pack_size) || 1;
    // ロット＋期限を受領した入庫(問屋・単価)を最優先
    const lotRec = await pool.query(
      `SELECT r.supplier_id, rd.unit_price FROM receipt_details rd JOIN receipts r ON r.id = rd.receipt_id
        WHERE rd.product_id = $1 AND rd.lot_number = $2 AND rd.expiry_date IS NOT DISTINCT FROM $3
        ORDER BY r.receipt_date DESC, rd.id DESC LIMIT 1`,
      [productId, lotNumber || '', expiryDate || null]
    );
    if (lotRec.rowCount) {
      supplierId = lotRec.rows[0].supplier_id;
      // 入庫単価が0/未設定ならマスター単価にフォールバックさせる
      if (lotRec.rows[0].unit_price != null && Number(lotRec.rows[0].unit_price) > 0) unitPrice = Number(lotRec.rows[0].unit_price);
    }
    if (supplierId == null && pd.rowCount) supplierId = pd.rows[0].supplier_id;
    if (unitPrice == null) {
      const up = await pool.query(
        `SELECT rd.unit_price FROM receipt_details rd JOIN receipts r ON r.id = rd.receipt_id
          WHERE rd.product_id = $1 ORDER BY r.receipt_date DESC, rd.id DESC LIMIT 1`, [productId]);
      if (up.rowCount) unitPrice = Number(up.rows[0].unit_price);
      else if (pd.rowCount) unitPrice = Number(pd.rows[0].unit_price);
    }
    let supplierName = '';
    if (supplierId != null) {
      const sn = await pool.query('SELECT name FROM suppliers WHERE id = $1', [supplierId]);
      supplierName = sn.rowCount ? sn.rows[0].name : '';
    }
    res.json({ supplierId, supplierName, unitPrice: unitPrice == null ? 0 : unitPrice, packSize });
  } catch (err) {
    console.error('返品既定取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 在庫の修正・廃棄・返品
// body: { productId, lotNumber?, expiryDate?, movementType(adjust|disposal|return),
//         quantity, reason, barcodeValue? }
//   adjust  : quantity = 修正後の在庫数(絶対値)
//   disposal/return : quantity = 減少するバラ数
router.post('/movement', async (req, res) => {
  const userId = req.session.user.id;
  const { productId, lotNumber = '', expiryDate = null, movementType, quantity, reason, barcodeValue,
          supplierId: bodySupplierId, unitPrice: bodyUnitPrice, quantityInput: bodyQtyInput,
          movementDate: bodyMovementDate } = req.body || {};

  if (!productId || !['adjust', 'disposal', 'return'].includes(movementType)) {
    return res.status(400).json({ error: '商品IDと移動区分(adjust/disposal/return)は必須です' });
  }
  if (!reason) {
    return res.status(400).json({ error: '理由は必須です' });
  }
  const qty = Number(quantity);
  if (Number.isNaN(qty) || qty < 0) {
    return res.status(400).json({ error: '数量が不正です' });
  }
  // 対象日(修正/廃棄/返品の記録日・集計日)。未指定・不正はNULL→集計時にcreated_at::dateを使用。
  const movementDate = (typeof bodyMovementDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bodyMovementDate))
    ? bodyMovementDate : null;

  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してください' });
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 施設スコープ: 対象商品が操作施設のものか確認
    if (!scope.all) {
      const chk = await client.query('SELECT facility_id FROM products WHERE id = $1', [productId]);
      if (chk.rowCount === 0 || String(chk.rows[0].facility_id) !== String(scope.facilityId)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '対象の商品が見つかりません' });
      }
    }

    let opts = {
      productId, lotNumber, expiryDate,
      movementType, userId, reason, relatedId: null, movementDate,
    };
    if (movementType === 'adjust') {
      opts.targetQuantity = qty;      // 絶対値へ調整
      opts.allowNegative = false;
    } else {
      opts.delta = -qty;              // 廃棄・返品は減少
      opts.allowNegative = false;
    }

    // 返品は精算用に問屋・単価・入力数量を保持。既定は「そのロット＋期限を仕入れた入庫実績」
    // (受領した問屋・単価)から解決し、無ければ商品単位でフォールバック。
    if (movementType === 'return') {
      let supplierId = bodySupplierId || null;
      if (supplierId) {
        const sc = await client.query('SELECT 1 FROM suppliers WHERE id = $1 AND facility_id = $2', [supplierId, scope.facilityId]);
        if (sc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '対象施設の問屋を指定してください' }); }
      }
      let unitPrice = (bodyUnitPrice !== undefined && bodyUnitPrice !== '' && bodyUnitPrice !== null) ? Number(bodyUnitPrice) : null;
      // 1) ロット＋期限を受領した入庫(problem: 問屋・単価) を最優先
      if (supplierId == null || unitPrice == null) {
        const lotRec = await client.query(
          `SELECT r.supplier_id, rd.unit_price FROM receipt_details rd JOIN receipts r ON r.id = rd.receipt_id
            WHERE rd.product_id = $1 AND rd.lot_number = $2 AND rd.expiry_date IS NOT DISTINCT FROM $3
            ORDER BY r.receipt_date DESC, rd.id DESC LIMIT 1`,
          [productId, lotNumber || '', expiryDate || null]
        );
        if (lotRec.rowCount) {
          if (supplierId == null && lotRec.rows[0].supplier_id != null) supplierId = lotRec.rows[0].supplier_id;
          // 入庫単価が0/未設定ならマスター単価にフォールバックさせる
          if (unitPrice == null && lotRec.rows[0].unit_price != null && Number(lotRec.rows[0].unit_price) > 0) unitPrice = Number(lotRec.rows[0].unit_price);
        }
      }
      // 2) 問屋フォールバック: 商品の主問屋
      if (supplierId == null) {
        const s = await client.query(
          `SELECT supplier_id FROM product_details
            WHERE product_id = $1 AND supplier_id IS NOT NULL
            ORDER BY (apply_start_date <= CURRENT_DATE AND (apply_end_date IS NULL OR apply_end_date >= CURRENT_DATE)) DESC,
                     apply_start_date DESC LIMIT 1`,
          [productId]
        );
        supplierId = s.rowCount ? s.rows[0].supplier_id : null;
      }
      // 3) 単価フォールバック: 最新入庫→商品詳細
      if (unitPrice == null) {
        const up = await client.query(
          `SELECT rd.unit_price FROM receipt_details rd JOIN receipts r ON r.id = rd.receipt_id
            WHERE rd.product_id = $1 ORDER BY r.receipt_date DESC, rd.id DESC LIMIT 1`,
          [productId]
        );
        if (up.rowCount) unitPrice = Number(up.rows[0].unit_price);
        else {
          const pd = await client.query('SELECT unit_price FROM product_details WHERE product_id = $1 ORDER BY apply_start_date DESC LIMIT 1', [productId]);
          unitPrice = pd.rowCount ? Number(pd.rows[0].unit_price) : 0;
        }
      }
      opts.supplierId = supplierId;
      opts.unitPrice = unitPrice;
      opts.quantityInput = (bodyQtyInput != null && bodyQtyInput !== '') ? Number(bodyQtyInput) : null;
    }

    const result = await applyStockChange(client, opts);

    // 個体(独自バーコード)対象なら使用済みにする。
    // 施設スコープ: 操作施設の商品に紐づくバーコードのみ対象(他施設の個体を改変させない)。
    if (barcodeValue) {
      await client.query(
        `UPDATE barcodes SET used_flag = TRUE
          WHERE barcode_value = $1
            AND product_id IN (SELECT id FROM products WHERE facility_id = $2)`,
        [barcodeValue, scope.facilityId]
      );
    }

    await writeLog(client, {
      userId, targetTable: 'product_stocks', targetId: null, operationType: '在庫調整',
      before: { stock_quantity: result.before },
      after: { movementType, productId, lotNumber, expiryDate, stock_quantity: result.after, reason },
    });

    await client.query('COMMIT');
    res.json({ ok: true, before: result.before, after: result.after, delta: result.delta });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('在庫調整エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
