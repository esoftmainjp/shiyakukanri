'use strict';

const express = require('express');
const { pool, getClient } = require('../db');
const { parseCsv, sendCsv } = require('../services/csv');
const { facilityScope } = require('../services/facility');
const { writeLog } = require('../services/log');
const { getFacilityPlan } = require('../services/plan');

// 取込での商品追加上限。現在数を返す(max=NULL は無制限)。
async function productLimit(client, fid) {
  const plan = await getFacilityPlan(client, fid);
  const max = plan ? plan.max_products : null;
  const existing = Number((await client.query('SELECT COUNT(*) AS c FROM products WHERE facility_id = $1', [fid])).rows[0].c);
  return { max, existing };
}

const router = express.Router();

function truthy(v) {
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === '○' || s === 'yes' || s === 'y' || s === 'はい';
}

// メーカーJANコードの桁数(商品JANの先頭何桁をメーカーコードとするか)
const MAKER_CODE_LEN = 7;

// メーカー名を解決。無ければ商品JANの先頭N桁をJANメーカーコードにして自動追加。
// 施設スコープ内で検索・作成する。戻り値: { id, created }
async function resolveMaker(client, name, janCode, facilityId) {
  const nm = (name || '').trim();
  if (!nm) return { id: null, created: false };
  const found = await client.query(`SELECT id FROM makers WHERE name = $1 AND facility_id = $2`, [nm, facilityId]);
  if (found.rowCount > 0) return { id: found.rows[0].id, created: false };
  const code = String(janCode || '').replace(/\D/g, '').slice(0, MAKER_CODE_LEN);
  const ins = await client.query(
    `INSERT INTO makers (name, jan_maker_code, facility_id) VALUES ($1, $2, $3) RETURNING id`,
    [nm, code, facilityId]
  );
  return { id: ins.rows[0].id, created: true };
}

// 名称マスタ(部門・分類)を施設スコープ内で解決。無ければ自動追加する。
// 戻り値: { id, created }
async function resolveNamed(client, table, name, facilityId) {
  const nm = (name || '').trim();
  if (!nm) return { id: null, created: false };
  const found = await client.query(`SELECT id FROM ${table} WHERE name = $1 AND facility_id = $2`, [nm, facilityId]);
  if (found.rowCount > 0) return { id: found.rows[0].id, created: false };
  const ins = await client.query(`INSERT INTO ${table} (name, facility_id) VALUES ($1, $2) RETURNING id`, [nm, facilityId]);
  return { id: ins.rows[0].id, created: true };
}

// 全体管理者が施設未選択のときは施設を特定できないため取込不可。
function requireFacility(req, res) {
  const scope = facilityScope(req);
  if (scope.all) { res.status(400).json({ error: '対象施設を選択してから取り込んでください' }); return null; }
  return scope.facilityId;
}

// 商品マスターCSVインポート
// ヘッダー: 名称,カナ,部門,分類,管理コード,試薬管理対象,棚
router.post('/products', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length === 0) return res.status(400).json({ error: 'データがありません' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let inserted = 0;
    let skipped = 0;
    let departmentsCreated = 0;
    let categoriesCreated = 0;
    let shelvesCreated = 0;
    const { max: maxProducts, existing: existingProducts } = await productLimit(client, fid);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = (r['名称'] || '').trim();
      if (!name) { errors.push({ line: i + 2, error: '名称が空です' }); continue; }

      // 重複チェックは商品名で行う(同一施設内。既存があればスキップ)
      const dup = await client.query(`SELECT id FROM products WHERE name = $1 AND facility_id = $2`, [name, fid]);
      if (dup.rowCount > 0) { skipped++; continue; }

      // プラン上限チェック(全件取消)
      if (maxProducts != null && existingProducts + inserted >= maxProducts) {
        errors.push({ line: i + 2, error: `商品マスター登録数の上限(${maxProducts}件)を超えます。上位プランへの変更をご検討ください。` });
        break;
      }

      // 部門・分類は無ければ自動追加(同一施設内)
      let deptId = null, catId = null;
      if (r['部門']) {
        const d = await resolveNamed(client, 'departments', r['部門'], fid);
        deptId = d.id; if (d.created) departmentsCreated++;
      }
      if (r['分類']) {
        const c = await resolveNamed(client, 'categories', r['分類'], fid);
        catId = c.id; if (c.created) categoriesCreated++;
      }

      // 棚(保管場所)は必須。空欄は「棚１」を既定として使う(無ければ自動追加)。
      const shelf = await resolveNamed(client, 'shelves', r['棚'] || '棚１', fid);
      if (shelf.created) shelvesCreated++;
      // 管理コードは顧客用の任意コード(システムキーではない)
      await client.query(
        `INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag, shelf_id, facility_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [name, r['カナ'] || '', deptId, catId, r['管理コード'] || '', truthy(r['試薬管理対象'] || r['精度管理対象']), shelf.id, fid]
      );
      inserted++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', inserted: 0, errors });
    }
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'CSV取込', facilityId: fid,
      after: { inserted, skipped, departmentsCreated, categoriesCreated, shelvesCreated },
    });
    res.json({ ok: true, inserted, skipped, departmentsCreated, categoriesCreated, shelvesCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品詳細マスターCSVインポート
// ヘッダー: 商品名,適用開始日,適用終了日,数量単位,梱包数,梱包単位,規格,単価,テスト数,最低個数,発注個数,JANコード,メーカー,問屋,バーコード発行
// 商品は「商品名」で特定する(管理コードは使わない)。同名商品が複数ある場合はエラー。
router.post('/product-details', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length === 0) return res.status(400).json({ error: 'データがありません' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let inserted = 0;
    let makersCreated = 0;
    let suppliersCreated = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const pname = (r['商品名'] || '').trim();
      if (!pname) { errors.push({ line: i + 2, error: '商品名が空です' }); continue; }

      const p = await client.query(`SELECT id FROM products WHERE name = $1 AND facility_id = $2`, [pname, fid]);
      if (p.rowCount === 0) { errors.push({ line: i + 2, error: `商品が存在しません: ${pname}` }); continue; }
      if (p.rowCount > 1) { errors.push({ line: i + 2, error: `同名の商品が複数あります: ${pname}` }); continue; }

      let makerId = null, supplierId = null;
      if (r['メーカー']) {
        const mk = await resolveMaker(client, r['メーカー'], r['JANコード'], fid);
        makerId = mk.id;
        if (mk.created) makersCreated++;
      }
      if (r['問屋']) {
        const s = await resolveNamed(client, 'suppliers', r['問屋'], fid);
        supplierId = s.id; if (s.created) suppliersCreated++;
      }

      await client.query(
        `INSERT INTO product_details
           (product_id, apply_start_date, apply_end_date, quantity_unit, pack_size, pack_unit,
            spec, unit_price, test_count, min_quantity, order_quantity, jan_code,
            maker_id, supplier_id, barcode_issue_flag, facility_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
          fid,
        ]
      );
      inserted++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', inserted: 0, errors });
    }
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'product_details', operationType: 'CSV取込', facilityId: fid,
      after: { inserted, makersCreated, suppliersCreated },
    });
    res.json({ ok: true, inserted, makersCreated, suppliersCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品詳細インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品＋商品詳細 同時インポート
// ヘッダー: 名称,カナ,部門,分類,管理コード,試薬管理対象,棚,
//           適用開始日,適用終了日,数量単位,梱包数,梱包単位,規格,単価,テスト数,最低個数,発注個数,JANコード,メーカー,問屋,バーコード発行
// 各行: 商品名で商品を検索(あれば再利用/なければ新規作成)し、続けて商品詳細を1件作成する。
// 商品と商品詳細は商品ID(内部)で紐付ける。管理コードは顧客用の任意コードで、システムキーではない。
router.post('/products-combined', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length === 0) return res.status(400).json({ error: 'データがありません' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let productsCreated = 0;
    let detailsCreated = 0;
    let makersCreated = 0;
    let departmentsCreated = 0;
    let categoriesCreated = 0;
    let suppliersCreated = 0;
    let shelvesCreated = 0;
    const { max: maxProducts, existing: existingProducts } = await productLimit(client, fid);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = i + 2;
      const name = (r['名称'] || '').trim();
      const code = (r['管理コード'] || '').trim(); // 顧客用の任意コード(システムキーではない)
      if (!name) { errors.push({ line, error: '名称が空です' }); continue; }

      // 部門・分類は無ければ自動追加(同一施設内)
      let deptId = null, catId = null;
      if (r['部門']) {
        const d = await resolveNamed(client, 'departments', r['部門'], fid);
        deptId = d.id; if (d.created) departmentsCreated++;
      }
      if (r['分類']) {
        const c = await resolveNamed(client, 'categories', r['分類'], fid);
        catId = c.id; if (c.created) categoriesCreated++;
      }

      // メーカー(無ければJAN先頭7桁で自動追加)・問屋の解決
      let makerId = null, supplierId = null;
      if (r['メーカー']) {
        const mk = await resolveMaker(client, r['メーカー'], r['JANコード'], fid);
        makerId = mk.id;
        if (mk.created) makersCreated++;
      }
      if (r['問屋']) {
        const s = await resolveNamed(client, 'suppliers', r['問屋'], fid);
        supplierId = s.id; if (s.created) suppliersCreated++;
      }

      // 商品: 商品名で検索し、あれば再利用/なければ新規作成(重複チェックは商品名・同一施設)
      let productId;
      const ex = await client.query(`SELECT id FROM products WHERE name = $1 AND facility_id = $2`, [name, fid]);
      if (ex.rowCount > 0) {
        productId = ex.rows[0].id;
      } else {
        // プラン上限チェック(全件取消)
        if (maxProducts != null && existingProducts + productsCreated >= maxProducts) {
          errors.push({ line, error: `商品マスター登録数の上限(${maxProducts}件)を超えます。上位プランへの変更をご検討ください。` });
          break;
        }
        // 棚(保管場所)は必須。空欄は「棚１」を既定として使う(無ければ自動追加)。
        const shelf = await resolveNamed(client, 'shelves', r['棚'] || '棚１', fid);
        if (shelf.created) shelvesCreated++;
        const ins = await client.query(
          `INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag, shelf_id, facility_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [name, r['カナ'] || '', deptId, catId, code, truthy(r['試薬管理対象'] || r['精度管理対象']), shelf.id, fid]
        );
        productId = ins.rows[0].id;
        productsCreated++;
      }

      // 商品詳細を作成
      await client.query(
        `INSERT INTO product_details
           (product_id, apply_start_date, apply_end_date, quantity_unit, pack_size, pack_unit,
            spec, unit_price, test_count, min_quantity, order_quantity, jan_code,
            maker_id, supplier_id, barcode_issue_flag, facility_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
          fid,
        ]
      );
      detailsCreated++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', productsCreated: 0, detailsCreated: 0, makersCreated: 0, errors });
    }
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'CSV取込', facilityId: fid,
      after: { productsCreated, detailsCreated, makersCreated, departmentsCreated, categoriesCreated, suppliersCreated, shelvesCreated },
    });
    res.json({ ok: true, productsCreated, detailsCreated, makersCreated, departmentsCreated, categoriesCreated, suppliersCreated, shelvesCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品＋詳細インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品マスタCSVエクスポート(商品のみ。インポートと同じ形式)
// ヘッダー: 名称,カナ,部門,分類,管理コード,試薬管理対象,棚
router.get('/products/export', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  try {
    const { rows } = await pool.query(
      `SELECT p.name, p.kana, d.name AS dept, c.name AS cat, p.management_code,
              CASE WHEN p.qc_target_flag THEN '1' ELSE '' END AS qc, sh.name AS shelf
         FROM products p
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN shelves sh ON sh.id = p.shelf_id
        WHERE p.facility_id = $1
        ORDER BY p.name`,
      [fid]
    );
    const columns = [
      { key: 'name', label: '名称' }, { key: 'kana', label: 'カナ' },
      { key: 'dept', label: '部門' }, { key: 'cat', label: '分類' },
      { key: 'management_code', label: '管理コード' }, { key: 'qc', label: '試薬管理対象' },
      { key: 'shelf', label: '棚' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'CSV出力',
      after: { file: '商品マスタ.csv', count: rows.length },
    });
    sendCsv(res, '商品マスタ.csv', columns, rows);
  } catch (err) {
    console.error('商品エクスポートエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 商品＋商品詳細CSVエクスポート(インポートの「商品＋商品詳細」と同じ形式)
// ヘッダー: 名称,カナ,部門,分類,管理コード,試薬管理対象,適用開始日,適用終了日,
//           数量単位,梱包数,梱包単位,規格,単価,テスト数,最低個数,発注個数,JANコード,メーカー,問屋,バーコード発行
router.get('/products-combined/export', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  try {
    const { rows } = await pool.query(
      `SELECT p.name, p.kana, d.name AS dept, c.name AS cat, p.management_code,
              CASE WHEN p.qc_target_flag THEN '1' ELSE '' END AS qc, sh.name AS shelf,
              to_char(pd.apply_start_date, 'YYYY-MM-DD') AS apply_start_date,
              to_char(pd.apply_end_date, 'YYYY-MM-DD')   AS apply_end_date,
              pd.quantity_unit, pd.pack_size, pd.pack_unit, pd.spec, pd.unit_price,
              pd.test_count, pd.min_quantity, pd.order_quantity, pd.jan_code,
              mk.name AS maker, s.name AS supplier,
              CASE WHEN pd.barcode_issue_flag THEN '1' ELSE '' END AS bc
         FROM products p
         JOIN product_details pd ON pd.product_id = p.id
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN shelves sh ON sh.id = p.shelf_id
         LEFT JOIN makers mk ON mk.id = pd.maker_id
         LEFT JOIN suppliers s ON s.id = pd.supplier_id
        WHERE p.facility_id = $1
        ORDER BY p.name, pd.id`,
      [fid]
    );
    const columns = [
      { key: 'name', label: '名称' }, { key: 'kana', label: 'カナ' },
      { key: 'dept', label: '部門' }, { key: 'cat', label: '分類' },
      { key: 'management_code', label: '管理コード' }, { key: 'qc', label: '試薬管理対象' },
      { key: 'shelf', label: '棚' },
      { key: 'apply_start_date', label: '適用開始日' }, { key: 'apply_end_date', label: '適用終了日' },
      { key: 'quantity_unit', label: '数量単位' }, { key: 'pack_size', label: '梱包数' }, { key: 'pack_unit', label: '梱包単位' },
      { key: 'spec', label: '規格' }, { key: 'unit_price', label: '単価' }, { key: 'test_count', label: 'テスト数' },
      { key: 'min_quantity', label: '最低個数' }, { key: 'order_quantity', label: '発注個数' }, { key: 'jan_code', label: 'JANコード' },
      { key: 'maker', label: 'メーカー' }, { key: 'supplier', label: '問屋' }, { key: 'bc', label: 'バーコード発行' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'product_details', operationType: 'CSV出力',
      after: { file: '商品＋商品詳細.csv', count: rows.length },
    });
    sendCsv(res, '商品＋商品詳細.csv', columns, rows);
  } catch (err) {
    console.error('商品＋詳細エクスポートエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
