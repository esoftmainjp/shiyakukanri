'use strict';

const express = require('express');
const { pool } = require('../db');
const { facilityScope } = require('../services/facility');

const router = express.Router();

// 商品 + 商品詳細の一覧 (入庫・出庫・発注画面の選択肢)
router.get('/products', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [];
    let facCond = '';
    if (!scope.all) { params.push(scope.facilityId); facCond = ` AND p.facility_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name, p.management_code, p.qc_target_flag,
              pd.id AS product_detail_id, pd.spec, pd.pack_size, pd.unit_price,
              pd.supplier_id, s.name AS supplier_name,
              pd.barcode_issue_flag, pd.jan_code
         FROM products p
         JOIN product_details pd ON pd.product_id = p.id
         LEFT JOIN suppliers s ON s.id = pd.supplier_id
        WHERE p.is_active = TRUE${facCond}
        ORDER BY p.name, pd.id`,
      params
    );
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.product_id)) {
        map.set(r.product_id, {
          productId: r.product_id,
          productName: r.product_name,
          managementCode: r.management_code,
          qcTarget: r.qc_target_flag,
          details: [],
        });
      }
      map.get(r.product_id).details.push({
        productDetailId: r.product_detail_id,
        spec: r.spec,
        packSize: r.pack_size,
        unitPrice: r.unit_price,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        barcodeIssueFlag: r.barcode_issue_flag,
        janCode: r.jan_code,
      });
    }
    res.json({ products: [...map.values()] });
  } catch (err) {
    console.error('商品一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 問屋一覧
router.get('/suppliers', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [];
    let facCond = '';
    if (!scope.all) { params.push(scope.facilityId); facCond = ` AND facility_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT id, name FROM suppliers WHERE is_active = TRUE${facCond} ORDER BY kana, name`,
      params
    );
    res.json({ suppliers: rows });
  } catch (err) {
    console.error('問屋一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 部門一覧
router.get('/departments', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [];
    let where = '';
    if (!scope.all) { params.push(scope.facilityId); where = 'WHERE facility_id = $1'; }
    const { rows } = await pool.query(`SELECT id, name FROM departments ${where} ORDER BY name`, params);
    res.json({ departments: rows });
  } catch (err) {
    console.error('部門一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 分類一覧
router.get('/categories', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [];
    let where = '';
    if (!scope.all) { params.push(scope.facilityId); where = 'WHERE facility_id = $1'; }
    const { rows } = await pool.query(`SELECT id, name FROM categories ${where} ORDER BY name`, params);
    res.json({ categories: rows });
  } catch (err) {
    console.error('分類一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// メーカー一覧
router.get('/makers', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [];
    let where = '';
    if (!scope.all) { params.push(scope.facilityId); where = 'WHERE facility_id = $1'; }
    const { rows } = await pool.query(`SELECT id, name FROM makers ${where} ORDER BY name`, params);
    res.json({ makers: rows });
  } catch (err) {
    console.error('メーカー一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 棚一覧 (入庫画面の未登録商品スキャン→新規登録で使う。一般ユーザーも参照可)
router.get('/shelves', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [];
    let where = 'WHERE is_active = TRUE';
    if (!scope.all) { params.push(scope.facilityId); where += ` AND facility_id = $${params.length}`; }
    const { rows } = await pool.query(`SELECT id, name FROM shelves ${where} ORDER BY kana, name`, params);
    res.json({ shelves: rows });
  } catch (err) {
    console.error('棚一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 商品のロット別在庫 (出庫画面のロット選択)
router.get('/stocks', async (req, res) => {
  const { productId } = req.query;
  const scope = facilityScope(req);
  try {
    const params = [];
    let where = 'WHERE s.stock_quantity > 0';
    if (productId) {
      params.push(productId);
      where += ` AND s.product_id = $${params.length}`;
    }
    if (!scope.all) {
      params.push(scope.facilityId);
      where += ` AND p.facility_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.product_id, p.name AS product_name,
              s.lot_number, s.expiry_date, s.stock_quantity
         FROM product_stocks s
         JOIN products p ON p.id = s.product_id
         ${where}
        ORDER BY p.name, s.expiry_date NULLS LAST`,
      params
    );
    res.json({ stocks: rows });
  } catch (err) {
    console.error('在庫一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// JANコードから商品を照合 (GS1-128のGTIN用。先頭ゼロ差を正規化して一致)
router.get('/by-jan/:jan', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [req.params.jan];
    let facCond = '';
    if (!scope.all) { params.push(scope.facilityId); facCond = ` AND p.facility_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name,
              pd.id AS product_detail_id, pd.spec, pd.pack_size, pd.unit_price,
              pd.supplier_id, s.name AS supplier_name, pd.barcode_issue_flag, pd.jan_code
         FROM product_details pd
         JOIN products p ON p.id = pd.product_id
         LEFT JOIN suppliers s ON s.id = pd.supplier_id
        WHERE p.is_active = TRUE
          AND pd.jan_code <> ''
          AND regexp_replace(pd.jan_code, '^0+', '') = regexp_replace($1, '^0+', '')${facCond}
        ORDER BY pd.apply_start_date DESC
        LIMIT 1`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: '該当する商品(JAN)が見つかりません' });
    const r = rows[0];
    res.json({
      product: {
        productId: r.product_id, productName: r.product_name,
        productDetailId: r.product_detail_id, spec: r.spec,
        packSize: r.pack_size, unitPrice: r.unit_price,
        supplierId: r.supplier_id, supplierName: r.supplier_name,
        barcodeIssueFlag: r.barcode_issue_flag, janCode: r.jan_code,
      },
    });
  } catch (err) {
    console.error('JAN照合エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// バーコード照会
router.get('/barcode/:value', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const params = [req.params.value];
    let facCond = '';
    if (!scope.all) { params.push(scope.facilityId); facCond = ` AND p.facility_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT b.barcode_value, b.used_flag, b.product_id, p.name AS product_name,
              b.content_code, rd.lot_number, rd.expiry_date, rd.product_detail_id
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
        WHERE b.barcode_value = $1 AND b.voided_flag = FALSE${facCond}`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'バーコードが見つかりません' });
    res.json({ barcode: rows[0] });
  } catch (err) {
    console.error('バーコード照会エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 商品検索(検索モーダル用)。問屋/メーカー/部門/分類/商品名で絞り込み、
// 施設スコープ内の商品を返す。inStockOnly=true で在庫(バラ>0)のある商品のみ。
router.get('/product-search', async (req, res) => {
  const scope = facilityScope(req);
  try {
    const { supplierId, makerId, departmentId, categoryId, name, inStockOnly } = req.query;
    const where = ['p.is_active = TRUE'];
    const params = [];
    const add = (cond, val) => { params.push(val); where.push(cond.replace('$$', '$' + params.length)); };
    if (!scope.all) add('p.facility_id = $$', scope.facilityId);
    if (departmentId) add('p.department_id = $$', departmentId);
    if (categoryId) add('p.category_id = $$', categoryId);
    if (name) add('p.name ILIKE $$', '%' + name + '%');
    if (supplierId) add('EXISTS (SELECT 1 FROM product_details pd WHERE pd.product_id = p.id AND pd.supplier_id = $$)', supplierId);
    if (makerId) add('EXISTS (SELECT 1 FROM product_details pd WHERE pd.product_id = p.id AND pd.maker_id = $$)', makerId);
    if (String(inStockOnly) === 'true') {
      where.push('EXISTS (SELECT 1 FROM product_stocks ps WHERE ps.product_id = p.id AND ps.stock_quantity > 0)');
    }
    const { rows } = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name,
              d.name AS department, c.name AS category,
              COALESCE((SELECT SUM(stock_quantity) FROM product_stocks ps WHERE ps.product_id = p.id), 0) AS stock_total,
              (SELECT string_agg(DISTINCT s.name, ', ') FROM product_details pd2
                 JOIN suppliers s ON s.id = pd2.supplier_id WHERE pd2.product_id = p.id) AS supplier_names,
              (SELECT string_agg(DISTINCT m.name, ', ') FROM product_details pd2
                 JOIN makers m ON m.id = pd2.maker_id WHERE pd2.product_id = p.id) AS maker_names,
              (SELECT array_agg(DISTINCT pd2.supplier_id) FROM product_details pd2
                WHERE pd2.product_id = p.id AND pd2.supplier_id IS NOT NULL) AS supplier_ids
         FROM products p
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.name
        LIMIT 500`,
      params
    );
    res.json({ products: rows });
  } catch (err) {
    console.error('商品検索エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
