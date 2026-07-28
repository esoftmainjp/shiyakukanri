'use strict';

const express = require('express');
const { pool, getClient } = require('../db');
const { analyzeCsv, sendCsv } = require('../services/csv');
const { facilityScope } = require('../services/facility');
const { writeLog } = require('../services/log');
const { getFacilityPlan } = require('../services/plan');

// 取込フィールド定義。順序=標準の列順(内容推測の位置フォールバックに使用)。type=データ検証種別。
//   type: text/kana/int/num/date/jan/bool。required=必須(空でエラー)。
const PRODUCT_SPEC = [
  { field: '名称', type: 'text', required: true },
  { field: 'カナ', type: 'kana' },
  { field: '部門', type: 'text' },
  { field: '分類', type: 'text' },
  { field: '管理コード', type: 'text' },
  { field: '試薬管理対象', type: 'bool' },
  { field: '棚', type: 'text' },
];
const DETAIL_ONLY_SPEC = [
  { field: '適用開始日', type: 'date' },
  { field: '適用終了日', type: 'date' },
  { field: '数量単位', type: 'text' },
  { field: '梱包数', type: 'int' },
  { field: '梱包単位', type: 'text' },
  { field: '規格', type: 'text' },
  { field: '単価', type: 'num' },
  { field: 'テスト数', type: 'int' },
  { field: '最低個数', type: 'int' },
  { field: '発注個数', type: 'int' },
  { field: 'JANコード', type: 'jan' },
  { field: 'メーカー', type: 'text' },
  { field: '問屋', type: 'text' },
  { field: 'バーコード発行', type: 'bool' },
  { field: '開封後有効日数', type: 'int' },
];
const DETAIL_SPEC = [{ field: '商品名', type: 'text', required: true }, ...DETAIL_ONLY_SPEC];
const COMBINED_SPEC = [...PRODUCT_SPEC, ...DETAIL_ONLY_SPEC];

const router = express.Router();

// 取込での商品追加上限。現在数を返す(max=NULL は無制限)。
async function productLimit(client, fid) {
  const plan = await getFacilityPlan(client, fid);
  const max = plan ? plan.max_products : null;
  const existing = Number((await client.query('SELECT COUNT(*) AS c FROM products WHERE facility_id = $1', [fid])).rows[0].c);
  return { max, existing };
}

function truthy(v) {
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === '○' || s === 'yes' || s === 'y' || s === 'はい' || s === '有' || s === 'あり';
}

// 本日(日本時間)の YYYY-MM-DD。適用開始日が空のときの既定に使う(NOT NULL回避)。
function todayJst() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); }

// メーカーJANコードの桁数(商品JANの先頭何桁をメーカーコードとするか)
const MAKER_CODE_LEN = 7;

// メーカー名を解決。無ければ商品JANの先頭N桁をJANメーカーコードにして自動追加。
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

// 名称マスタ(部門・分類・棚・問屋)を施設スコープ内で解決。無ければ自動追加する。
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

// 取込オプション(ヘッダー有無・列割当の指定)を読む。
function analyzeOpts(req) {
  return {
    hasHeader: !(req.body && req.body.hasHeader === false),
    mapping: req.body && Array.isArray(req.body.mapping) ? req.body.mapping : undefined,
  };
}
function isPreview(req) { return !!(req.body && (req.body.preview || req.body.dryRun)); }

// 列の割当状況(全列)。プレビューで割当編集UIに使う。
function columnsOf(a) {
  return a.assign.map((field, c) => {
    const h = a.headerRow && a.headerRow[c] !== undefined ? String(a.headerRow[c]).trim() : '';
    let sample = '';
    for (const r of a.dataRows) { const v = r[c]; if (v !== undefined && String(v).trim() !== '') { sample = String(v).trim(); break; } }
    return { col: c, header: h !== '' ? h : `列${c + 1}`, field: field || null, sample };
  });
}
function previewResult(res, a, spec) {
  return res.json({
    ok: true, preview: true,
    columns: columnsOf(a), ignored: a.mapping.ignored, rowCount: a.rowCount,
    errors: a.errors.slice(0, 50), errorCount: a.errors.length,
    fields: spec.map((f) => ({ field: f.field, required: !!f.required, type: f.type })),
  });
}
// データ検証エラーがあれば 400 を返して true。
function respondIfDataErrors(res, a) {
  if (a.errors.length) {
    res.status(400).json({ error: 'データにエラーがあります(全件取消)', errors: a.errors.slice(0, 50), errorCount: a.errors.length });
    return true;
  }
  return false;
}

// 取込バッチ(作成した行ID群)を記録。新規作成が無ければ記録しない。
async function recordBatch(client, { facilityId, importType, userId, created, summary }) {
  const products = created.products || [];
  const details = created.details || [];
  if (products.length === 0 && details.length === 0) return null;
  const { rows } = await client.query(
    `INSERT INTO import_batches
       (facility_id, import_type, created_by, product_ids, detail_ids, department_ids, category_ids, supplier_ids, maker_ids, shelf_ids, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [facilityId, importType, userId || null,
      products, details,
      created.departments || [], created.categories || [], created.suppliers || [], created.makers || [], created.shelves || [],
      JSON.stringify(summary || {})]
  );
  return rows[0].id;
}

// 商品マスターCSVインポート
router.post('/products', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const a = analyzeCsv(req.body && req.body.csv, PRODUCT_SPEC, analyzeOpts(req));
  if (isPreview(req)) return previewResult(res, a, PRODUCT_SPEC);
  if (a.rowCount === 0) return res.status(400).json({ error: 'データがありません' });
  if (respondIfDataErrors(res, a)) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let inserted = 0, skipped = 0, departmentsCreated = 0, categoriesCreated = 0, shelvesCreated = 0;
    const created = { products: [], departments: [], categories: [], shelves: [] };
    const { max: maxProducts, existing: existingProducts } = await productLimit(client, fid);

    for (let i = 0; i < a.rows.length; i++) {
      const r = a.rows[i];
      const line = i + a.lineOffset;
      const name = (r['名称'] || '').trim();
      if (!name) { errors.push({ line, error: '名称が空です' }); continue; }

      const dup = await client.query(`SELECT id FROM products WHERE name = $1 AND facility_id = $2`, [name, fid]);
      if (dup.rowCount > 0) { skipped++; continue; }

      if (maxProducts != null && existingProducts + inserted >= maxProducts) {
        errors.push({ line, error: `商品マスター登録数の上限(${maxProducts}件)を超えます。上位プランへの変更をご検討ください。` });
        break;
      }

      let deptId = null, catId = null;
      if (r['部門']) { const d = await resolveNamed(client, 'departments', r['部門'], fid); deptId = d.id; if (d.created) { departmentsCreated++; created.departments.push(d.id); } }
      if (r['分類']) { const c = await resolveNamed(client, 'categories', r['分類'], fid); catId = c.id; if (c.created) { categoriesCreated++; created.categories.push(c.id); } }

      const shelf = await resolveNamed(client, 'shelves', r['棚'] || '棚１', fid);
      if (shelf.created) { shelvesCreated++; created.shelves.push(shelf.id); }
      const ins = await client.query(
        `INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag, shelf_id, facility_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [name, r['カナ'] || '', deptId, catId, r['管理コード'] || '', truthy(r['試薬管理対象']), shelf.id, fid]
      );
      created.products.push(ins.rows[0].id);
      inserted++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', inserted: 0, errors });
    }
    const batchId = await recordBatch(client, {
      facilityId: fid, importType: 'products', userId: req.session.user && req.session.user.id,
      created, summary: { inserted, skipped, departmentsCreated, categoriesCreated, shelvesCreated },
    });
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'CSV取込', facilityId: fid,
      after: { inserted, skipped, departmentsCreated, categoriesCreated, shelvesCreated, batchId },
    });
    res.json({ ok: true, inserted, skipped, departmentsCreated, categoriesCreated, shelvesCreated, batchId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品詳細マスターCSVインポート(商品は「商品名」で特定)
router.post('/product-details', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const a = analyzeCsv(req.body && req.body.csv, DETAIL_SPEC, analyzeOpts(req));
  if (isPreview(req)) return previewResult(res, a, DETAIL_SPEC);
  if (a.rowCount === 0) return res.status(400).json({ error: 'データがありません' });
  if (respondIfDataErrors(res, a)) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let inserted = 0, makersCreated = 0, suppliersCreated = 0;
    const created = { details: [], makers: [], suppliers: [] };

    for (let i = 0; i < a.rows.length; i++) {
      const r = a.rows[i];
      const line = i + a.lineOffset;
      const pname = (r['商品名'] || '').trim();
      if (!pname) { errors.push({ line, error: '商品名が空です' }); continue; }

      const p = await client.query(`SELECT id FROM products WHERE name = $1 AND facility_id = $2`, [pname, fid]);
      if (p.rowCount === 0) { errors.push({ line, error: `商品が存在しません: ${pname}` }); continue; }
      if (p.rowCount > 1) { errors.push({ line, error: `同名の商品が複数あります: ${pname}` }); continue; }

      let makerId = null, supplierId = null;
      if (r['メーカー']) { const mk = await resolveMaker(client, r['メーカー'], r['JANコード'], fid); makerId = mk.id; if (mk.created) { makersCreated++; created.makers.push(mk.id); } }
      if (r['問屋']) { const s = await resolveNamed(client, 'suppliers', r['問屋'], fid); supplierId = s.id; if (s.created) { suppliersCreated++; created.suppliers.push(s.id); } }

      const ins = await client.query(
        `INSERT INTO product_details
           (product_id, apply_start_date, apply_end_date, quantity_unit, pack_size, pack_unit,
            spec, unit_price, test_count, min_quantity, order_quantity, jan_code,
            maker_id, supplier_id, barcode_issue_flag, open_life_days, facility_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          p.rows[0].id,
          r['適用開始日'] || todayJst(), r['適用終了日'] || null,
          r['数量単位'] || '', Number(r['梱包数']) || 1, r['梱包単位'] || '',
          r['規格'] || '', Number(r['単価']) || 0, Number(r['テスト数']) || 0,
          Number(r['最低個数']) || 0, Number(r['発注個数']) || 0, r['JANコード'] || '',
          makerId, supplierId, truthy(r['バーコード発行']), Number(r['開封後有効日数']) || 0, fid,
        ]
      );
      created.details.push(ins.rows[0].id);
      inserted++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', inserted: 0, errors });
    }
    const batchId = await recordBatch(client, {
      facilityId: fid, importType: 'product-details', userId: req.session.user && req.session.user.id,
      created, summary: { inserted, makersCreated, suppliersCreated },
    });
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'product_details', operationType: 'CSV取込', facilityId: fid,
      after: { inserted, makersCreated, suppliersCreated, batchId },
    });
    res.json({ ok: true, inserted, makersCreated, suppliersCreated, batchId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品詳細インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品＋商品詳細 同時インポート
router.post('/products-combined', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const a = analyzeCsv(req.body && req.body.csv, COMBINED_SPEC, analyzeOpts(req));
  if (isPreview(req)) return previewResult(res, a, COMBINED_SPEC);
  if (a.rowCount === 0) return res.status(400).json({ error: 'データがありません' });
  if (respondIfDataErrors(res, a)) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const errors = [];
    let productsCreated = 0, detailsCreated = 0, makersCreated = 0, departmentsCreated = 0, categoriesCreated = 0, suppliersCreated = 0, shelvesCreated = 0;
    const created = { products: [], details: [], departments: [], categories: [], suppliers: [], makers: [], shelves: [] };
    const { max: maxProducts, existing: existingProducts } = await productLimit(client, fid);

    for (let i = 0; i < a.rows.length; i++) {
      const r = a.rows[i];
      const line = i + a.lineOffset;
      const name = (r['名称'] || '').trim();
      const code = (r['管理コード'] || '').trim();
      if (!name) { errors.push({ line, error: '名称が空です' }); continue; }

      let deptId = null, catId = null;
      if (r['部門']) { const d = await resolveNamed(client, 'departments', r['部門'], fid); deptId = d.id; if (d.created) { departmentsCreated++; created.departments.push(d.id); } }
      if (r['分類']) { const c = await resolveNamed(client, 'categories', r['分類'], fid); catId = c.id; if (c.created) { categoriesCreated++; created.categories.push(c.id); } }

      let makerId = null, supplierId = null;
      if (r['メーカー']) { const mk = await resolveMaker(client, r['メーカー'], r['JANコード'], fid); makerId = mk.id; if (mk.created) { makersCreated++; created.makers.push(mk.id); } }
      if (r['問屋']) { const s = await resolveNamed(client, 'suppliers', r['問屋'], fid); supplierId = s.id; if (s.created) { suppliersCreated++; created.suppliers.push(s.id); } }

      let productId;
      const ex = await client.query(`SELECT id FROM products WHERE name = $1 AND facility_id = $2`, [name, fid]);
      if (ex.rowCount > 0) {
        productId = ex.rows[0].id;
      } else {
        if (maxProducts != null && existingProducts + productsCreated >= maxProducts) {
          errors.push({ line, error: `商品マスター登録数の上限(${maxProducts}件)を超えます。上位プランへの変更をご検討ください。` });
          break;
        }
        const shelf = await resolveNamed(client, 'shelves', r['棚'] || '棚１', fid);
        if (shelf.created) { shelvesCreated++; created.shelves.push(shelf.id); }
        const ins = await client.query(
          `INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag, shelf_id, facility_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [name, r['カナ'] || '', deptId, catId, code, truthy(r['試薬管理対象']), shelf.id, fid]
        );
        productId = ins.rows[0].id;
        created.products.push(productId);
        productsCreated++;
      }

      const insD = await client.query(
        `INSERT INTO product_details
           (product_id, apply_start_date, apply_end_date, quantity_unit, pack_size, pack_unit,
            spec, unit_price, test_count, min_quantity, order_quantity, jan_code,
            maker_id, supplier_id, barcode_issue_flag, open_life_days, facility_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          productId,
          r['適用開始日'] || todayJst(), r['適用終了日'] || null,
          r['数量単位'] || '', Number(r['梱包数']) || 1, r['梱包単位'] || '',
          r['規格'] || '', Number(r['単価']) || 0, Number(r['テスト数']) || 0,
          Number(r['最低個数']) || 0, Number(r['発注個数']) || 0, r['JANコード'] || '',
          makerId, supplierId, truthy(r['バーコード発行']), Number(r['開封後有効日数']) || 0, fid,
        ]
      );
      created.details.push(insD.rows[0].id);
      detailsCreated++;
    }

    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '取込中にエラーがあります(全件取消)', productsCreated: 0, detailsCreated: 0, makersCreated: 0, errors });
    }
    const batchId = await recordBatch(client, {
      facilityId: fid, importType: 'products-combined', userId: req.session.user && req.session.user.id,
      created, summary: { productsCreated, detailsCreated, makersCreated, departmentsCreated, categoriesCreated, suppliersCreated, shelvesCreated },
    });
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'CSV取込', facilityId: fid,
      after: { productsCreated, detailsCreated, makersCreated, departmentsCreated, categoriesCreated, suppliersCreated, shelvesCreated, batchId },
    });
    res.json({ ok: true, productsCreated, detailsCreated, makersCreated, departmentsCreated, categoriesCreated, suppliersCreated, shelvesCreated, batchId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('商品＋詳細インポートエラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 商品が取引データ(在庫・入出庫・発注・バーコード・棚卸・支払など)で使われているか。
async function productsInUse(client, ids) {
  if (!ids || !ids.length) return { inUse: false };
  const checks = [
    ['product_stocks', '在庫'], ['receipt_details', '入庫'], ['issue_details', '出庫'],
    ['order_details', '発注'], ['barcodes', 'バーコード'], ['stock_movements', '在庫変動'],
    ['usage_records', '使用記録'], ['stocktake_lines', '棚卸'], ['supplier_bill_lines', '支払'],
  ];
  for (const [tbl, label] of checks) {
    const c = (await client.query(`SELECT 1 FROM ${tbl} WHERE product_id = ANY($1) LIMIT 1`, [ids])).rowCount;
    if (c) return { inUse: true, detail: label };
  }
  return { inUse: false };
}

// 施設内に取引データが1件でもあるか(リセットの可否判定)。
async function facilityHasTransactions(client, fid) {
  const checks = [
    ['product_stocks', '在庫'], ['receipt_details', '入庫'], ['issue_details', '出庫'],
    ['order_details', '発注'], ['barcodes', 'バーコード'], ['stock_movements', '在庫変動'],
    ['usage_records', '使用記録'], ['stocktake_lines', '棚卸'], ['supplier_bill_lines', '支払'],
  ];
  for (const [tbl, label] of checks) {
    const c = (await client.query(
      `SELECT 1 FROM ${tbl} t JOIN products p ON p.id = t.product_id WHERE p.facility_id = $1 LIMIT 1`, [fid]
    )).rowCount;
    if (c) return { inUse: true, detail: label };
  }
  return { inUse: false };
}

// 指定IDの区分マスターを安全に削除(他から参照されているものはセーブポイントで残す)。
async function deleteRefsSafe(client, fid, groups) {
  const deleted = {};
  for (const [tbl, ids] of groups) {
    deleted[tbl] = 0;
    for (const id of (ids || [])) {
      await client.query('SAVEPOINT sp_ref');
      try {
        const r = await client.query(`DELETE FROM ${tbl} WHERE id = $1 AND facility_id = $2`, [id, fid]);
        await client.query('RELEASE SAVEPOINT sp_ref');
        deleted[tbl] += r.rowCount;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_ref'); // 参照ありは残す
      }
    }
  }
  return deleted;
}

// 直近(未Undo)の取込バッチ情報。Undoボタンの表示制御に使う。
router.get('/last-batch', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  try {
    const b = (await pool.query(
      `SELECT id, import_type, product_ids, detail_ids, summary, created_at
         FROM import_batches WHERE facility_id = $1 AND undone = FALSE
        ORDER BY created_at DESC, id DESC LIMIT 1`, [fid]
    )).rows[0];
    if (!b) return res.json({ ok: true, batch: null });
    res.json({ ok: true, batch: { id: b.id, importType: b.import_type, products: b.product_ids.length, details: b.detail_ids.length, createdAt: b.created_at } });
  } catch (err) {
    console.error('last-batch取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 直近の取込を取り消す(取込前に戻す)。追加した行だけを削除。取引データがあれば中止。
router.post('/undo', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const b = (await client.query(
      `SELECT * FROM import_batches WHERE facility_id = $1 AND undone = FALSE
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [fid]
    )).rows[0];
    if (!b) { await client.query('ROLLBACK'); return res.status(400).json({ error: '取り消せる取込がありません' }); }

    const dep = await productsInUse(client, b.product_ids);
    if (dep.inUse) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `取込後に登録された${dep.detail}があるため取り消せません。先に該当データを取り消してください。` });
    }

    const delD = (await client.query(`DELETE FROM product_details WHERE facility_id = $1 AND id = ANY($2)`, [fid, b.detail_ids])).rowCount;
    const delP = (await client.query(`DELETE FROM products WHERE facility_id = $1 AND id = ANY($2)`, [fid, b.product_ids])).rowCount;
    await deleteRefsSafe(client, fid, [
      ['departments', b.department_ids], ['categories', b.category_ids], ['shelves', b.shelf_ids],
      ['suppliers', b.supplier_ids], ['makers', b.maker_ids],
    ]);
    await client.query(`UPDATE import_batches SET undone = TRUE, undone_at = now() WHERE id = $1`, [b.id]);
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'CSV取込取消', facilityId: fid,
      after: { batchId: b.id, deletedProducts: delP, deletedDetails: delD },
    });
    res.json({ ok: true, deletedProducts: delP, deletedDetails: delD });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('取込取消エラー:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// マスター全リセット。商品＋商品詳細＋区分マスター(部門/分類/棚/問屋/メーカー)を全削除。
// 取引データ(在庫・入出庫など)があれば中止して保護する。
router.post('/reset', async (req, res) => {
  const fid = requireFacility(req, res); if (fid == null) return;
  if (!(req.body && req.body.confirm)) return res.status(400).json({ error: '確認が必要です' });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const dep = await facilityHasTransactions(client, fid);
    if (dep.inUse) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${dep.detail}の履歴があるためリセットできません。先に在庫・入出庫などのデータを取り消してください。` });
    }
    const delD = (await client.query('DELETE FROM product_details WHERE facility_id = $1', [fid])).rowCount;
    const delP = (await client.query('DELETE FROM products WHERE facility_id = $1', [fid])).rowCount;
    // 区分マスターは全件対象。他(発注・入庫・支払など)から参照が残るものはセーブポイントで保護。
    const idsOf = async (tbl) => (await client.query(`SELECT id FROM ${tbl} WHERE facility_id = $1`, [fid])).rows.map((x) => x.id);
    const refDeleted = await deleteRefsSafe(client, fid, [
      ['departments', await idsOf('departments')], ['categories', await idsOf('categories')],
      ['shelves', await idsOf('shelves')], ['suppliers', await idsOf('suppliers')], ['makers', await idsOf('makers')],
    ]);
    await client.query('UPDATE import_batches SET undone = TRUE, undone_at = now() WHERE facility_id = $1 AND undone = FALSE', [fid]);
    await client.query('COMMIT');
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'products', operationType: 'マスター全リセット', facilityId: fid,
      after: { deletedProducts: delP, deletedDetails: delD, refDeleted },
    });
    res.json({ ok: true, deletedProducts: delP, deletedDetails: delD, refDeleted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('マスターリセットエラー:', err.message);
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
              CASE WHEN pd.barcode_issue_flag THEN '1' ELSE '' END AS bc,
              pd.open_life_days
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
      { key: 'open_life_days', label: '開封後有効日数' },
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
