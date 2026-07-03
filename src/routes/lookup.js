'use strict';

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// 商品 + 商品詳細の一覧 (入庫・出庫・発注画面の選択肢)
router.get('/products', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name, p.management_code, p.qc_target_flag,
              pd.id AS product_detail_id, pd.spec, pd.pack_size, pd.unit_price,
              pd.supplier_id, s.name AS supplier_name,
              pd.barcode_issue_flag, pd.jan_code
         FROM products p
         JOIN product_details pd ON pd.product_id = p.id
         LEFT JOIN suppliers s ON s.id = pd.supplier_id
        WHERE p.is_active = TRUE
        ORDER BY p.name, pd.id`
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
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM suppliers WHERE is_active = TRUE ORDER BY kana, name`
    );
    res.json({ suppliers: rows });
  } catch (err) {
    console.error('問屋一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 商品のロット別在庫 (出庫画面のロット選択)
router.get('/stocks', async (req, res) => {
  const { productId } = req.query;
  try {
    const params = [];
    let where = 'WHERE s.stock_quantity > 0';
    if (productId) {
      params.push(productId);
      where += ` AND s.product_id = $1`;
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
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS product_id, p.name AS product_name,
              pd.id AS product_detail_id, pd.spec, pd.pack_size, pd.unit_price,
              pd.supplier_id, s.name AS supplier_name, pd.barcode_issue_flag, pd.jan_code
         FROM product_details pd
         JOIN products p ON p.id = pd.product_id
         LEFT JOIN suppliers s ON s.id = pd.supplier_id
        WHERE p.is_active = TRUE
          AND pd.jan_code <> ''
          AND regexp_replace(pd.jan_code, '^0+', '') = regexp_replace($1, '^0+', '')
        ORDER BY pd.apply_start_date DESC
        LIMIT 1`,
      [req.params.jan]
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
  try {
    const { rows } = await pool.query(
      `SELECT b.barcode_value, b.used_flag, b.product_id, p.name AS product_name,
              b.content_code, rd.lot_number, rd.expiry_date, rd.product_detail_id
         FROM barcodes b
         JOIN products p ON p.id = b.product_id
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
        WHERE b.barcode_value = $1 AND b.voided_flag = FALSE`,
      [req.params.value]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'バーコードが見つかりません' });
    res.json({ barcode: rows[0] });
  } catch (err) {
    console.error('バーコード照会エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
