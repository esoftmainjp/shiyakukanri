'use strict';

const express = require('express');
const { getClient } = require('../db');
const { parseCsv } = require('../services/csv');

const router = express.Router();

function truthy(v) {
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === '○' || s === 'yes' || s === 'y' || s === 'はい';
}

// メーカーJANコードの桁数(商品JANの先頭何桁をメーカーコードとするか)
const MAKER_CODE_LEN = 7;

// メーカー名を解決。無ければ商品JANの先頭N桁をJANメーカーコードにして自動追加。
// 戻り値: { id, created }
async function resolveMaker(client, name, janCode) {
  const nm = (name || '').trim();
  if (!nm) return { id: null, created: false };
  const found = await client.query(`SELECT id FROM makers WHERE name = $1`, [nm]);
  if (found.rowCount > 0) return { id: found.rows[0].id, created: false };
  const code = String(janCode || '').replace(/\D/g, '').slice(0, MAKER_CODE_LEN);
  const ins = await client.query(
    `INSERT INTO makers (name, jan_maker_code) VALUES ($1, $2) RETURNING id`,
    [nm, code]
  );
  return { id: ins.rows[0].id, created: true };
}

// 商品マスターCSVインポート
// ヘッダー: 名称,カナ,部門,分類,管理コード,精度管理対象
router.post('/products', async (req, res) => {
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length === 0) return res.status(400).json({ error: 'データがありません' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let inserted = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = (r['名称'] || '').trim();
      if (!name) { errors.push({ line: i + 2, error: '名称が空です' }); continue; }

      let deptId = null, catId = null;
      if (r['部門']) {
        const d = await client.query(`SELECT id FROM departments WHERE name = $1`, [r['部門'].trim()]);
        if (d.rowCount === 0) { errors.push({ line: i + 2, error: `部門が存在しません: ${r['部門']}` }); continue; }
        deptId = d.rows[0].id;
      }
      if (r['分類']) {
        const c = await client.query(`SELECT id FROM categories WHERE name = $1`, [r['分類'].trim()]);
        if (c.rowCount === 0) { errors.push({ line: i + 2, error: `分類が存在しません: ${r['分類']}` }); continue; }
        catId = c.rows[0].id;
      }

      await client.query(
        `INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, r['カナ'] || '', deptId, catId, r['管理コード'] || '', truthy(r['精度管理対象'])]
      );
      inserted++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', inserted: 0, errors });
    }
    await client.query('COMMIT');
    res.json({ ok: true, inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品詳細マスターCSVインポート
// ヘッダー: 管理コード,適用開始日,適用終了日,数量単位,梱包数,梱包単位,規格,単価,テスト数,最低個数,発注個数,JANコード,メーカー,問屋,バーコード発行
router.post('/product-details', async (req, res) => {
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length === 0) return res.status(400).json({ error: 'データがありません' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let inserted = 0;
    let makersCreated = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const code = (r['管理コード'] || '').trim();
      if (!code) { errors.push({ line: i + 2, error: '管理コードが空です' }); continue; }

      const p = await client.query(`SELECT id FROM products WHERE management_code = $1`, [code]);
      if (p.rowCount === 0) { errors.push({ line: i + 2, error: `商品(管理コード)が存在しません: ${code}` }); continue; }

      let makerId = null, supplierId = null;
      if (r['メーカー']) {
        const mk = await resolveMaker(client, r['メーカー'], r['JANコード']);
        makerId = mk.id;
        if (mk.created) makersCreated++;
      }
      if (r['問屋']) {
        const s = await client.query(`SELECT id FROM suppliers WHERE name = $1`, [r['問屋'].trim()]);
        if (s.rowCount === 0) { errors.push({ line: i + 2, error: `問屋が存在しません: ${r['問屋']}` }); continue; }
        supplierId = s.rows[0].id;
      }

      await client.query(
        `INSERT INTO product_details
           (product_id, apply_start_date, apply_end_date, quantity_unit, pack_size, pack_unit,
            spec, unit_price, test_count, min_quantity, order_quantity, jan_code,
            maker_id, supplier_id, barcode_issue_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          p.rows[0].id,
          r['適用開始日'] || null,
          r['適用終了日'] || null,
          r['数量単位'] || '',
          Number(r['梱包数']) || 1,
          r['梱包単位'] || '',
          r['規格'] || '',
          Number(r['単価']) || 0,
          Number(r['テスト数']) || 0,
          Number(r['最低個数']) || 0,
          Number(r['発注個数']) || 0,
          r['JANコード'] || '',
          makerId,
          supplierId,
          truthy(r['バーコード発行']),
        ]
      );
      inserted++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', inserted: 0, errors });
    }
    await client.query('COMMIT');
    res.json({ ok: true, inserted, makersCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品詳細インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品＋商品詳細 同時インポート
// ヘッダー: 名称,カナ,部門,分類,管理コード,精度管理対象,
//           適用開始日,適用終了日,数量単位,梱包数,梱包単位,規格,単価,テスト数,最低個数,発注個数,JANコード,メーカー,問屋,バーコード発行
// 各行: 管理コードで商品を検索(あれば再利用/なければ新規作成)し、続けて商品詳細を1件作成する。
router.post('/products-combined', async (req, res) => {
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length === 0) return res.status(400).json({ error: 'データがありません' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let productsCreated = 0;
    let detailsCreated = 0;
    let makersCreated = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = i + 2;
      const name = (r['名称'] || '').trim();
      const code = (r['管理コード'] || '').trim();
      if (!name) { errors.push({ line, error: '名称が空です' }); continue; }
      if (!code) { errors.push({ line, error: '管理コードが空です(商品と詳細の紐付けに必須)' }); continue; }

      // 部門・分類の解決
      let deptId = null, catId = null;
      if (r['部門']) {
        const d = await client.query(`SELECT id FROM departments WHERE name = $1`, [r['部門'].trim()]);
        if (d.rowCount === 0) { errors.push({ line, error: `部門が存在しません: ${r['部門']}` }); continue; }
        deptId = d.rows[0].id;
      }
      if (r['分類']) {
        const c = await client.query(`SELECT id FROM categories WHERE name = $1`, [r['分類'].trim()]);
        if (c.rowCount === 0) { errors.push({ line, error: `分類が存在しません: ${r['分類']}` }); continue; }
        catId = c.rows[0].id;
      }

      // メーカー(無ければJAN先頭7桁で自動追加)・問屋の解決
      let makerId = null, supplierId = null;
      if (r['メーカー']) {
        const mk = await resolveMaker(client, r['メーカー'], r['JANコード']);
        makerId = mk.id;
        if (mk.created) makersCreated++;
      }
      if (r['問屋']) {
        const s = await client.query(`SELECT id FROM suppliers WHERE name = $1`, [r['問屋'].trim()]);
        if (s.rowCount === 0) { errors.push({ line, error: `問屋が存在しません: ${r['問屋']}` }); continue; }
        supplierId = s.rows[0].id;
      }

      // 商品: 管理コードで検索し、あれば再利用/なければ新規作成
      let productId;
      const ex = await client.query(`SELECT id FROM products WHERE management_code = $1`, [code]);
      if (ex.rowCount > 0) {
        productId = ex.rows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [name, r['カナ'] || '', deptId, catId, code, truthy(r['精度管理対象'])]
        );
        productId = ins.rows[0].id;
        productsCreated++;
      }

      // 商品詳細を作成
      await client.query(
        `INSERT INTO product_details
           (product_id, apply_start_date, apply_end_date, quantity_unit, pack_size, pack_unit,
            spec, unit_price, test_count, min_quantity, order_quantity, jan_code,
            maker_id, supplier_id, barcode_issue_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          productId,
          r['適用開始日'] || null,
          r['適用終了日'] || null,
          r['数量単位'] || '',
          Number(r['梱包数']) || 1,
          r['梱包単位'] || '',
          r['規格'] || '',
          Number(r['単価']) || 0,
          Number(r['テスト数']) || 0,
          Number(r['最低個数']) || 0,
          Number(r['発注個数']) || 0,
          r['JANコード'] || '',
          makerId,
          supplierId,
          truthy(r['バーコード発行']),
        ]
      );
      detailsCreated++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', productsCreated: 0, detailsCreated: 0, makersCreated: 0, errors });
    }
    await client.query('COMMIT');
    res.json({ ok: true, productsCreated, detailsCreated, makersCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品＋詳細インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
