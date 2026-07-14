'use strict';

// 入庫画面の未登録商品スキャン → その場で商品＋商品詳細を新規登録する。
//   POST /api/quick-product   product{...} と detail{...} を受け、1トランザクションで作成。
// 通常のマスター登録(/api/masters)は管理者のみだが、この経路は入庫作業の一環として
// 一般ユーザーにも許可する(server.js の requireRole で admin/general/superadmin を許可)。
// 施設スコープ・プラン上限(商品数)・JAN重複(既存を返す)に対応する。

const express = require('express');
const { pool } = require('../db');
const { writeLog } = require('../services/log');
const { facilityScope } = require('../services/facility');
const { getFacilityPlan, canAdd } = require('../services/plan');

const router = express.Router();

// products / product_details の保存対象カラム(ホワイトリスト。SQLインジェクション防止)
const PRODUCT_COLS = ['name', 'kana', 'department_id', 'category_id', 'management_code', 'qc_target_flag', 'shelf_id', 'note'];
const DETAIL_COLS = ['apply_start_date', 'apply_end_date', 'quantity_unit', 'pack_size', 'pack_unit',
  'spec', 'unit_price', 'test_count', 'min_quantity', 'order_quantity', 'jan_code',
  'maker_id', 'supplier_id', 'barcode_issue_flag', 'expiry_warn_days', 'open_life_days', 'note'];
const DATE_COLS = new Set(['apply_start_date', 'apply_end_date']);
const NUM_COLS = new Set(['pack_size', 'unit_price', 'test_count', 'min_quantity', 'order_quantity', 'expiry_warn_days', 'open_life_days']);
const REF_COLS = new Set(['department_id', 'category_id', 'shelf_id', 'maker_id', 'supplier_id']);

function todayJst() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); }

// 保存対象の [col, value] を返す。value===undefined は「この列は省略(DB既定)」。
// 空の日付→NULL、空の数値→省略、空の参照ID→NULL。
function coerceCol(col, v) {
  if (v === '' || v === null || v === undefined) {
    if (DATE_COLS.has(col)) return null;
    if (NUM_COLS.has(col)) return undefined;
    if (REF_COLS.has(col)) return null;
    return v === undefined ? undefined : (v === null ? null : v); // 文字列の空はそのまま('')
  }
  return v;
}

// JANで既存の商品詳細を照合(先頭ゼロ差を正規化)。見つかれば入庫画面が使える形で返す。
async function findByJan(client, jan, facilityId) {
  const { rows } = await client.query(
    `SELECT p.id AS product_id, p.name AS product_name, p.management_code, p.qc_target_flag,
            pd.id AS product_detail_id, pd.spec, pd.pack_size, pd.unit_price,
            pd.supplier_id, s.name AS supplier_name, pd.barcode_issue_flag, pd.jan_code
       FROM product_details pd
       JOIN products p ON p.id = pd.product_id
       LEFT JOIN suppliers s ON s.id = pd.supplier_id
      WHERE p.is_active = TRUE AND pd.jan_code <> ''
        AND regexp_replace(pd.jan_code, '^0+', '') = regexp_replace($1, '^0+', '')
        AND p.facility_id = $2
      ORDER BY pd.apply_start_date DESC
      LIMIT 1`,
    [String(jan), facilityId]
  );
  return rows[0] || null;
}

function toProduct(r) {
  return {
    productId: r.product_id, productName: r.product_name,
    managementCode: r.management_code, qcTarget: r.qc_target_flag,
    productDetailId: r.product_detail_id, spec: r.spec,
    packSize: r.pack_size, unitPrice: r.unit_price,
    supplierId: r.supplier_id, supplierName: r.supplier_name,
    barcodeIssueFlag: r.barcode_issue_flag, janCode: r.jan_code,
  };
}

router.post('/', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してから登録してください' });
  const facilityId = scope.facilityId;
  const body = req.body || {};
  const product = body.product || {};
  const detail = body.detail || {};

  // 必須項目チェック(商品名・部門・分類・問屋・棚・梱包数・適用開始日・適用終了日・JAN・メーカー)
  const missing = [];
  if (!String(product.name || '').trim()) missing.push('商品名');
  if (!product.department_id) missing.push('部門');
  if (!product.category_id) missing.push('分類');
  if (!product.shelf_id) missing.push('棚');
  if (!detail.supplier_id) missing.push('問屋');
  if (!detail.maker_id) missing.push('メーカー');
  if (!String(detail.jan_code || '').trim()) missing.push('JANコード');
  if (!(Number(detail.pack_size) >= 1)) missing.push('梱包数(1以上)');
  if (!String(detail.apply_start_date || '').trim()) missing.push('適用開始日');
  if (!String(detail.apply_end_date || '').trim()) missing.push('適用終了日');
  if (missing.length) return res.status(400).json({ error: `必須項目が未入力です：${missing.join('、')}` });

  const client = await pool.connect();
  try {
    // JAN重複: 同一施設に同じJANの商品詳細があれば、新規作成せず既存を返す
    const dup = await findByJan(client, detail.jan_code, facilityId);
    if (dup) return res.json({ existing: true, product: toProduct(dup) });

    // プラン上限(商品数)チェック
    const plan = await getFacilityPlan(client, facilityId);
    if (plan) {
      const c = (await client.query('SELECT COUNT(*) AS c FROM products WHERE facility_id = $1', [facilityId])).rows[0].c;
      if (!canAdd(c, plan.max_products)) {
        return res.status(400).json({ error: `商品マスター登録数の上限（${plan.name}：${plan.max_products}件）に達しています。上位プランへの変更をご検討ください。` });
      }
    }

    await client.query('BEGIN');

    // 商品を作成
    const pCols = ['facility_id'];
    const pVals = [facilityId];
    for (const col of PRODUCT_COLS) {
      const v = coerceCol(col, product[col]);
      if (v === undefined) continue;
      pCols.push(col); pVals.push(v);
    }
    const pPh = pVals.map((_, i) => '$' + (i + 1)).join(', ');
    const pr = await client.query(`INSERT INTO products (${pCols.join(', ')}) VALUES (${pPh}) RETURNING id`, pVals);
    const productId = pr.rows[0].id;

    // 商品詳細を作成(施設スコープを付与。マスター登録と同様)
    if (!String(detail.apply_start_date || '').trim()) detail.apply_start_date = todayJst();
    const dCols = ['product_id', 'facility_id'];
    const dVals = [productId, facilityId];
    for (const col of DETAIL_COLS) {
      const v = coerceCol(col, detail[col]);
      if (v === undefined) continue;
      dCols.push(col); dVals.push(v);
    }
    const dPh = dVals.map((_, i) => '$' + (i + 1)).join(', ');
    const dr = await client.query(`INSERT INTO product_details (${dCols.join(', ')}) VALUES (${dPh}) RETURNING id`, dVals);
    const productDetailId = dr.rows[0].id;

    await writeLog(client, { userId: req.session.user.id, targetTable: 'products', targetId: productId, operationType: '登録' });
    await writeLog(client, { userId: req.session.user.id, targetTable: 'product_details', targetId: productDetailId, operationType: '登録' });

    await client.query('COMMIT');

    // 入庫画面が即利用できるよう、作成した商品を照合形で返す
    const created = await findByJan(client, detail.jan_code, facilityId);
    res.status(201).json({ existing: false, product: created ? toProduct(created) : null });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    console.error('簡易商品登録エラー:', err.message);
    if (err.code === '23505') return res.status(400).json({ error: '同じ値が既に登録されています（重複）' });
    res.status(400).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
