'use strict';

// 棚卸し(実地棚卸・在庫実数照合)
//   開始(スナップショット) → カウント(手入力/バーコードスキャン) → 差異確認 → 確定
//   確定で applyStockChange(targetQuantity=実数) により在庫を実数へ調整し、
//   バーコード品は未スキャンの有効個体を void(紛失)する。
//   閲覧は admin/general/superadmin、変更系(開始/カウント/確定/取消)は施設選択必須。

const express = require('express');
const { pool, getClient } = require('../db');
const { applyStockChange } = require('../services/inventory');
const { sendCsv } = require('../services/csv');
const { writeLog } = require('../services/log');
const { facilityScope } = require('../services/facility');
const { isGs1, extractGs1 } = require('../../public/gs1');

const router = express.Router();

// スキャンした現物の明細を確保する。棚卸しの絞り込み条件に一致する施設内商品で
// 明細が未作成なら、その場で追加する(開始後に入庫された在庫などを計上できる)。
// 対象外(別施設/絞り込み条件外)なら null を返す。
async function ensureLine(client, st, productId, lot, exp) {
  let scopeF = {};
  try { scopeF = JSON.parse(st.scope_note || '{}'); } catch (e) { scopeF = {}; }

  const p = await client.query(
    `SELECT category_id, department_id, qc_target_flag
       FROM products WHERE id = $1 AND facility_id = $2`,
    [productId, st.facility_id]
  );
  if (p.rowCount === 0) return null;             // 別施設 or 商品なし
  const pr = p.rows[0];
  if (scopeF.categoryId && String(pr.category_id) !== String(scopeF.categoryId)) return null;
  if (scopeF.departmentId && String(pr.department_id) !== String(scopeF.departmentId)) return null;
  if (scopeF.qcOnly && pr.qc_target_flag !== true) return null;

  const ex = await client.query(
    `SELECT id, is_barcode FROM stocktake_lines
      WHERE stocktake_id = $1 AND product_id = $2 AND lot_number = $3
        AND expiry_date IS NOT DISTINCT FROM $4`,
    [st.id, productId, lot, exp]
  );
  if (ex.rowCount) return { lineId: ex.rows[0].id, is_barcode: ex.rows[0].is_barcode, created: false };

  // 未作成 → 追加。is_barcode は active barcode 有無、理論在庫は現在の在庫数。
  const isBc = (await client.query(
    `SELECT EXISTS(SELECT 1 FROM barcodes b JOIN receipt_details rd ON rd.id = b.receipt_detail_id
                    WHERE b.product_id = $1 AND rd.lot_number = $2
                      AND rd.expiry_date IS NOT DISTINCT FROM $3
                      AND b.used_flag = FALSE AND b.voided_flag = FALSE) AS e`,
    [productId, lot, exp]
  )).rows[0].e;
  const th = await client.query(
    `SELECT COALESCE(stock_quantity, 0) AS q FROM product_stocks
      WHERE product_id = $1 AND lot_number = $2 AND expiry_date IS NOT DISTINCT FROM $3`,
    [productId, lot, exp]
  );
  const theoretical = th.rowCount ? Number(th.rows[0].q) : 0;
  const ins = await client.query(
    `INSERT INTO stocktake_lines (stocktake_id, product_id, lot_number, expiry_date, is_barcode, theoretical_qty)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT uq_stocktake_lines DO NOTHING
     RETURNING id`,
    [st.id, productId, lot, exp, isBc, theoretical]
  );
  let lineId;
  if (ins.rowCount) lineId = ins.rows[0].id;
  else {
    const again = await client.query(
      `SELECT id FROM stocktake_lines
        WHERE stocktake_id = $1 AND product_id = $2 AND lot_number = $3
          AND expiry_date IS NOT DISTINCT FROM $4`,
      [st.id, productId, lot, exp]
    );
    lineId = again.rows[0].id;
  }
  return { lineId, is_barcode: isBc, created: true };
}

// 明細の実数を ok スキャン数から再計算し、カウント済みにする。
async function recountLine(client, stocktakeId, lineId, userId) {
  const cnt = await client.query(
    `SELECT COUNT(*) AS c FROM stocktake_scans
      WHERE stocktake_id = $1 AND line_id = $2 AND result = 'ok'`,
    [stocktakeId, lineId]
  );
  const countedQty = Number(cnt.rows[0].c);
  await client.query(
    `UPDATE stocktake_lines
        SET counted_qty = $1, counted_by = $2, counted_at = now(), status = 'counted'
      WHERE id = $3`,
    [countedQty, userId, lineId]
  );
  return countedQty;
}

// 棚卸しヘッダを取得し施設スコープを検証する。db は pool か tx client。
// forUpdate=true のときは FOR UPDATE でロックする。
async function loadStocktake(db, id, scope, forUpdate = false) {
  const r = await db.query(
    `SELECT * FROM stocktakes WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]
  );
  if (r.rowCount === 0) return { error: { status: 404, msg: '棚卸しが見つかりません' } };
  const st = r.rows[0];
  if (!scope.all && String(st.facility_id) !== String(scope.facilityId)) {
    return { error: { status: 404, msg: '棚卸しが見つかりません' } };
  }
  return { st };
}

// ------------------------------------------------------------
// 一覧
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const scope = facilityScope(req);
    const params = [];
    const where = [];
    const add = (cond, val) => { params.push(val); where.push(cond.replace('$$', '$' + params.length)); };
    if (!scope.all) add('st.facility_id = $$', scope.facilityId);
    if (req.query.status) add('st.status = $$', req.query.status);
    const { rows } = await pool.query(
      `SELECT st.id, st.facility_id, f.name AS facility_name, st.title, st.status,
              st.started_at, st.confirmed_at, st.canceled_at,
              su.name AS started_by_name, cu.name AS confirmed_by_name,
              (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = st.id) AS line_count,
              (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = st.id AND l.counted_qty IS NOT NULL) AS counted_count
         FROM stocktakes st
         JOIN facilities f ON f.id = st.facility_id
         LEFT JOIN users su ON su.id = st.started_by
         LEFT JOIN users cu ON cu.id = st.confirmed_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY st.id DESC`,
      params
    );
    res.json({ stocktakes: rows });
  } catch (err) {
    console.error('棚卸し一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ------------------------------------------------------------
// 明細取得(ヘッダ+明細)
// ------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const scope = facilityScope(req);
    const { st, error } = await loadStocktake(pool, req.params.id, scope);
    if (error) return res.status(error.status).json({ error: error.msg });
    const lines = await pool.query(
      `SELECT l.id, l.product_id, p.name AS product_name, c.name AS category, d.name AS department,
              l.lot_number, l.expiry_date, l.is_barcode,
              l.theoretical_qty, l.counted_qty, l.status, l.note,
              l.counted_by, cu.name AS counted_by_name, l.counted_at
         FROM stocktake_lines l
         JOIN products p ON p.id = l.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN users cu ON cu.id = l.counted_by
        WHERE l.stocktake_id = $1
        ORDER BY p.name, l.lot_number, l.expiry_date NULLS LAST`,
      [st.id]
    );
    res.json({ stocktake: st, lines: lines.rows });
  } catch (err) {
    console.error('棚卸し詳細エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ------------------------------------------------------------
// 差異確認(差異+バーコード紛失候補)
// ------------------------------------------------------------
router.get('/:id/diff', async (req, res) => {
  try {
    const scope = facilityScope(req);
    const { st, error } = await loadStocktake(pool, req.params.id, scope);
    if (error) return res.status(error.status).json({ error: error.msg });
    const lines = await pool.query(
      `SELECT l.id, l.product_id, p.name AS product_name,
              l.lot_number, l.expiry_date, l.is_barcode,
              l.theoretical_qty, l.counted_qty, l.status,
              (SELECT ps.stock_quantity FROM product_stocks ps
                WHERE ps.product_id = l.product_id AND ps.lot_number = l.lot_number
                  AND ps.expiry_date IS NOT DISTINCT FROM l.expiry_date) AS live_qty
         FROM stocktake_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.stocktake_id = $1
        ORDER BY p.name, l.lot_number, l.expiry_date NULLS LAST`,
      [st.id]
    );
    const rows = lines.rows.map((l) => {
      const counted = l.counted_qty == null ? null : Number(l.counted_qty);
      const theoretical = Number(l.theoretical_qty);
      const live = l.live_qty == null ? 0 : Number(l.live_qty);
      return {
        ...l,
        difference: counted == null ? null : counted - theoretical,
        live_qty: live,
        drift: live !== theoretical,
      };
    });
    // バーコード紛失候補(有効個体のうち ok スキャンされていないもの)
    const missing = await pool.query(
      `SELECT b.barcode_value, p.name AS product_name, rd.lot_number, rd.expiry_date
         FROM stocktake_lines l
         JOIN products p ON p.id = l.product_id
         JOIN receipt_details rd ON rd.product_id = l.product_id
              AND rd.lot_number = l.lot_number
              AND rd.expiry_date IS NOT DISTINCT FROM l.expiry_date
         JOIN barcodes b ON b.receipt_detail_id = rd.id AND b.product_id = l.product_id
              AND b.voided_flag = FALSE AND b.used_flag = FALSE
        WHERE l.stocktake_id = $1 AND l.is_barcode = TRUE
          AND b.id NOT IN (SELECT barcode_id FROM stocktake_scans
                            WHERE stocktake_id = $1 AND result = 'ok' AND barcode_id IS NOT NULL)
        ORDER BY p.name`,
      [st.id]
    );
    res.json({ stocktake: st, lines: rows, missingBarcodes: missing.rows });
  } catch (err) {
    console.error('棚卸し差異エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ------------------------------------------------------------
// 差異帳票CSV
// ------------------------------------------------------------
router.get('/:id/csv', async (req, res) => {
  try {
    const scope = facilityScope(req);
    const { st, error } = await loadStocktake(pool, req.params.id, scope);
    if (error) return res.status(error.status).json({ error: error.msg });
    const lines = await pool.query(
      `SELECT p.name AS product_name, l.lot_number, l.expiry_date, l.is_barcode,
              l.theoretical_qty, l.counted_qty, l.status
         FROM stocktake_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.stocktake_id = $1
        ORDER BY p.name, l.lot_number, l.expiry_date NULLS LAST`,
      [st.id]
    );
    const rows = lines.rows.map((l) => ({
      product_name: l.product_name,
      lot_number: l.lot_number,
      expiry_date: l.expiry_date || '',
      kind: l.is_barcode ? 'バーコード' : '数量',
      theoretical_qty: l.theoretical_qty,
      counted_qty: l.counted_qty == null ? '未カウント' : l.counted_qty,
      difference: l.counted_qty == null ? '' : Number(l.counted_qty) - Number(l.theoretical_qty),
    }));
    const columns = [
      { key: 'product_name', label: '商品名' },
      { key: 'lot_number', label: 'ロット' },
      { key: 'expiry_date', label: '使用期限' },
      { key: 'kind', label: '区分' },
      { key: 'theoretical_qty', label: '理論在庫' },
      { key: 'counted_qty', label: '実数' },
      { key: 'difference', label: '差異' },
    ];
    const fname = `棚卸し_${st.id}_${(st.title || '').replace(/[\\/:*?"<>|]/g, '')}.csv`;
    sendCsv(res, fname, columns, rows);
  } catch (err) {
    console.error('棚卸しCSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ------------------------------------------------------------
// バーコード明細の個体一覧(スキャン済み/未スキャンの内訳)
//   バーコード品のどの個体を読み終えたかを確認するための展開用。
// ------------------------------------------------------------
router.get('/:id/lines/:lineId/barcodes', async (req, res) => {
  try {
    const scope = facilityScope(req);
    const { st, error } = await loadStocktake(pool, req.params.id, scope);
    if (error) return res.status(error.status).json({ error: error.msg });
    const lr = await pool.query(
      `SELECT * FROM stocktake_lines WHERE id = $1 AND stocktake_id = $2`,
      [req.params.lineId, st.id]
    );
    if (lr.rowCount === 0) return res.status(404).json({ error: '明細が見つかりません' });
    const line = lr.rows[0];
    // 有効個体を content_code 順で、スキャン済み(ok)かどうかを付けて返す
    const bc = await pool.query(
      `SELECT b.id, b.barcode_value, b.content_code,
              EXISTS (SELECT 1 FROM stocktake_scans s
                       WHERE s.stocktake_id = $1 AND s.line_id = $2
                         AND s.result = 'ok' AND s.barcode_id = b.id) AS scanned
         FROM barcodes b
         JOIN receipt_details rd ON rd.id = b.receipt_detail_id
        WHERE b.product_id = $3 AND rd.lot_number = $4
          AND rd.expiry_date IS NOT DISTINCT FROM $5
          AND b.voided_flag = FALSE AND b.used_flag = FALSE
        ORDER BY b.content_code`,
      [st.id, line.id, line.product_id, line.lot_number || '', line.expiry_date]
    );
    const barcodes = bc.rows;
    const scannedCount = barcodes.filter((x) => x.scanned).length;
    res.json({
      lineId: line.id, isBarcode: line.is_barcode,
      total: barcodes.length, scanned: scannedCount, remaining: barcodes.length - scannedCount,
      barcodes,
    });
  } catch (err) {
    console.error('棚卸しバーコード内訳エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ------------------------------------------------------------
// 開始(理論在庫スナップショット生成)
//   body: { title?, categoryId?, departmentId?, qcOnly?, includeZero? }
// ------------------------------------------------------------
router.post('/', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してください' });
  const userId = req.session.user.id;
  const { title = '', categoryId = null, departmentId = null, qcOnly = false, includeZero = false } = req.body || {};

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const scopeNote = JSON.stringify({ categoryId, departmentId, qcOnly: !!qcOnly, includeZero: !!includeZero });
    const head = await client.query(
      `INSERT INTO stocktakes (facility_id, title, status, scope_note, started_by)
       VALUES ($1, $2, 'open', $3, $4) RETURNING id`,
      [scope.facilityId, title, scopeNote, userId]
    );
    const stocktakeId = head.rows[0].id;

    // 対象 product_stocks を明細へコピー。is_barcode は active barcode 有無で凍結。
    const ins = await client.query(
      `INSERT INTO stocktake_lines
         (stocktake_id, product_id, lot_number, expiry_date, is_barcode, theoretical_qty)
       SELECT $1, ps.product_id, ps.lot_number, ps.expiry_date,
              EXISTS (SELECT 1 FROM barcodes b
                        JOIN receipt_details rd ON rd.id = b.receipt_detail_id
                       WHERE b.product_id = ps.product_id
                         AND rd.lot_number = ps.lot_number
                         AND rd.expiry_date IS NOT DISTINCT FROM ps.expiry_date
                         AND b.used_flag = FALSE AND b.voided_flag = FALSE),
              COALESCE(ps.stock_quantity, 0)
         FROM product_stocks ps
         JOIN products p ON p.id = ps.product_id
        WHERE p.facility_id = $2
          AND ($3::bigint IS NULL OR p.category_id = $3)
          AND ($4::bigint IS NULL OR p.department_id = $4)
          AND ($5 = FALSE OR p.qc_target_flag = TRUE)
          AND ($6 = TRUE OR COALESCE(ps.stock_quantity, 0) > 0)
        RETURNING id`,
      [stocktakeId, scope.facilityId,
       categoryId || null, departmentId || null, !!qcOnly, !!includeZero]
    );

    await writeLog(client, {
      userId, targetTable: 'stocktakes', targetId: stocktakeId, operationType: '棚卸し開始',
      after: { title, lineCount: ins.rowCount, scope: scopeNote },
      facilityId: scope.facilityId,
    });

    await client.query('COMMIT');
    res.json({ ok: true, id: stocktakeId, lineCount: ins.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('棚卸し開始エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// 手入力カウント(非バーコード品)/ 備考更新
//   body: { countedQty?, note? }
// ------------------------------------------------------------
router.patch('/:id/lines/:lineId', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してください' });
  const userId = req.session.user.id;
  const { countedQty, note } = req.body || {};

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { st, error } = await loadStocktake(client, req.params.id, scope, true);
    if (error) { await client.query('ROLLBACK'); return res.status(error.status).json({ error: error.msg }); }
    if (!['open', 'counting'].includes(st.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '確定またはキャンセル済みの棚卸しは編集できません' });
    }
    const lr = await client.query(
      `SELECT * FROM stocktake_lines WHERE id = $1 AND stocktake_id = $2 FOR UPDATE`,
      [req.params.lineId, st.id]
    );
    if (lr.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: '明細が見つかりません' }); }
    const line = lr.rows[0];

    const hasCount = countedQty !== undefined && countedQty !== null && countedQty !== '';
    if (hasCount) {
      if (line.is_barcode) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'バーコード品はスキャンでカウントします' });
      }
      const qty = Number(countedQty);
      if (!Number.isInteger(qty) || qty < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '実数は0以上の整数で入力してください' });
      }
      await client.query(
        `UPDATE stocktake_lines
            SET counted_qty = $1, counted_by = $2, counted_at = now(), status = 'counted',
                note = COALESCE($3, note)
          WHERE id = $4`,
        [qty, userId, note !== undefined ? note : null, line.id]
      );
    } else if (note !== undefined) {
      await client.query(`UPDATE stocktake_lines SET note = $1 WHERE id = $2`, [note, line.id]);
    }

    if (st.status === 'open') {
      await client.query(`UPDATE stocktakes SET status = 'counting' WHERE id = $1`, [st.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('棚卸しカウントエラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// バーコードスキャン
//   body: { barcodeValue }
//   独自バーコード(1本=バラ1個)は個体単位で照合。
//   GS1-128/JANコード(メーカー既製・数量管理品のバラ)は商品×ロット×期限で
//   該当明細を +1 する(バラ1個=1スキャン)。
// ------------------------------------------------------------
router.post('/:id/scan', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してください' });
  const userId = req.session.user.id;
  const value = String((req.body || {}).barcodeValue || '').trim();
  if (!value) return res.status(400).json({ error: 'バーコード値が必要です' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { st, error } = await loadStocktake(client, req.params.id, scope, true);
    if (error) { await client.query('ROLLBACK'); return res.status(error.status).json({ error: error.msg }); }
    if (!['open', 'counting'].includes(st.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '確定またはキャンセル済みの棚卸しはスキャンできません' });
    }

    let result;
    let lineId = null;
    let barcodeId = null;
    let countedQty = null;
    let added = false;

    if (isGs1(value)) {
      // ---- GS1-128(メーカー既製バーコード): 数量管理品のバラを +1 ----
      const info = extractGs1(value);
      const jan = String(info.jan || '').trim();
      const lot = info.lot || '';
      const exp = info.expiry || null;
      if (!jan) {
        await client.query('ROLLBACK');
        return res.json({ ok: true, result: 'unknown', message: 'バーコードから商品を特定できませんでした' });
      }
      // JANで商品を特定(先頭ゼロ差を正規化、操作施設内)
      const pr = await client.query(
        `SELECT DISTINCT p.id, p.name
           FROM product_details pd JOIN products p ON p.id = pd.product_id
          WHERE p.facility_id = $1 AND pd.jan_code <> ''
            AND regexp_replace(pd.jan_code, '^0+', '') = regexp_replace($2, '^0+', '')
          LIMIT 1`,
        [scope.facilityId, jan]
      );
      if (pr.rowCount === 0) {
        result = 'unknown';
        await client.query(
          `INSERT INTO stocktake_scans (stocktake_id, line_id, barcode_id, barcode_value, result, scanned_by)
           VALUES ($1, NULL, NULL, $2, 'unknown', $3)`,
          [st.id, jan, userId]
        );
      } else {
        const productId = pr.rows[0].id;
        const el = await ensureLine(client, st, productId, lot, exp);
        if (!el) {
          result = 'other_lot';
          await client.query(
            `INSERT INTO stocktake_scans (stocktake_id, line_id, barcode_id, barcode_value, result, scanned_by)
             VALUES ($1, NULL, NULL, $2, 'other_lot', $3)`,
            [st.id, jan, userId]
          );
        } else if (el.is_barcode) {
          // 個別(独自)バーコード管理の商品は個体スキャンで数える
          await client.query('ROLLBACK');
          return res.json({ ok: true, result: 'need_barcode', message: 'この商品は個別バーコードで管理されています。個別バーコードを読み取ってください。' });
        } else {
          lineId = el.lineId;
          added = el.created;
          result = 'ok';
          await client.query(
            `INSERT INTO stocktake_scans (stocktake_id, line_id, barcode_id, barcode_value, result, scanned_by)
             VALUES ($1, $2, NULL, $3, 'ok', $4)`,
            [st.id, lineId, jan, userId]
          );
          countedQty = await recountLine(client, st.id, lineId, userId);
        }
      }
    } else {
      // ---- 独自バーコード(個体単位) ----
      const bc = await client.query(
        `SELECT b.id, b.used_flag, b.voided_flag, b.product_id, p.facility_id,
                rd.lot_number, rd.expiry_date
           FROM barcodes b
           JOIN products p ON p.id = b.product_id
           LEFT JOIN receipt_details rd ON rd.id = b.receipt_detail_id
          WHERE b.barcode_value = $1`,
        [value]
      );

      if (bc.rowCount === 0) {
        result = 'unknown';
      } else {
        const b = bc.rows[0];
        barcodeId = b.id;
        if (String(b.facility_id) !== String(scope.facilityId)) {
          result = 'other_facility';
        } else if (b.voided_flag) {
          result = 'voided';
        } else if (b.used_flag) {
          result = 'used';
        } else {
          const lot = b.lot_number || '';
          const exp = b.expiry_date || null;
          const el = await ensureLine(client, st, b.product_id, lot, exp);
          if (!el) {
            result = 'other_lot';   // 絞り込み条件外/別施設の個体
          } else {
            lineId = el.lineId;
            added = el.created;
            result = 'ok';
          }
        }
      }

      if (barcodeId != null) {
        // 同一個体の既存スキャンを確認
        const ex = await client.query(
          `SELECT id, result, line_id FROM stocktake_scans WHERE stocktake_id = $1 AND barcode_id = $2`,
          [st.id, barcodeId]
        );
        if (ex.rowCount && ex.rows[0].result === 'ok') {
          // 既に計上済み(有効) → 二重スキャン。確認のため対象行を返す(フロントで最上部へ移動)
          await client.query('ROLLBACK');
          return res.json({ ok: true, result: 'duplicate', lineId: ex.rows[0].line_id, message: 'この個体は既にスキャン済みです' });
        }
        if (ex.rowCount) {
          // 以前の非ok(対象外等)を今回の結果で上書き(棚卸し表に後から現れた等)
          await client.query(
            `UPDATE stocktake_scans SET line_id = $1, result = $2, barcode_value = $3, scanned_by = $4, scanned_at = now()
              WHERE id = $5`,
            [lineId, result, value, userId, ex.rows[0].id]
          );
        } else {
          await client.query(
            `INSERT INTO stocktake_scans (stocktake_id, line_id, barcode_id, barcode_value, result, scanned_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [st.id, lineId, barcodeId, value, result, userId]
          );
        }
      } else {
        // 未登録の独自バーコード(個体特定できず) → 記録のみ
        await client.query(
          `INSERT INTO stocktake_scans (stocktake_id, line_id, barcode_id, barcode_value, result, scanned_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [st.id, lineId, barcodeId, value, result, userId]
        );
      }

      if (result === 'ok' && lineId != null) {
        countedQty = await recountLine(client, st.id, lineId, userId);
      }
    }

    if (st.status === 'open') {
      await client.query(`UPDATE stocktakes SET status = 'counting' WHERE id = $1`, [st.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, result, lineId, countedQty, added });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('棚卸しスキャンエラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// 確定(在庫へ反映)
// ------------------------------------------------------------
router.post('/:id/confirm', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してください' });
  const userId = req.session.user.id;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { st, error } = await loadStocktake(client, req.params.id, scope, true);
    if (error) { await client.query('ROLLBACK'); return res.status(error.status).json({ error: error.msg }); }
    if (!['open', 'counting'].includes(st.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'この棚卸しは既に確定またはキャンセルされています' });
    }

    const lines = await client.query(
      `SELECT * FROM stocktake_lines WHERE stocktake_id = $1 ORDER BY id`, [st.id]
    );

    let confirmedLines = 0;
    let totalDiff = 0;
    let voidedTotal = 0;
    const drift = [];
    let uncounted = 0;

    for (const line of lines.rows) {
      if (line.counted_qty == null) { uncounted += 1; continue; }
      const counted = Number(line.counted_qty);
      const theoretical = Number(line.theoretical_qty);

      const r = await applyStockChange(client, {
        productId: line.product_id, lotNumber: line.lot_number || '', expiryDate: line.expiry_date,
        targetQuantity: counted, movementType: 'stocktake', relatedId: st.id,
        userId, reason: '棚卸し確定', allowNegative: false,
      });
      confirmedLines += 1;
      totalDiff += counted - theoretical;
      if (Number(r.before) !== theoretical) {
        drift.push({ lineId: line.id, theoretical, live: Number(r.before) });
      }

      if (line.is_barcode) {
        // ok スキャンされなかった有効個体を紛失として void
        const okIds = await client.query(
          `SELECT barcode_id FROM stocktake_scans
            WHERE stocktake_id = $1 AND line_id = $2 AND result = 'ok' AND barcode_id IS NOT NULL`,
          [st.id, line.id]
        );
        const ids = okIds.rows.map((x) => x.barcode_id);
        const v = await client.query(
          `UPDATE barcodes SET voided_flag = TRUE
            WHERE product_id = $1 AND voided_flag = FALSE AND used_flag = FALSE
              AND receipt_detail_id IN (
                    SELECT id FROM receipt_details
                     WHERE product_id = $1 AND lot_number = $2
                       AND expiry_date IS NOT DISTINCT FROM $3)
              AND id <> ALL($4::bigint[])`,
          [line.product_id, line.lot_number || '', line.expiry_date, ids]
        );
        voidedTotal += v.rowCount;
      }

      await client.query(`UPDATE stocktake_lines SET status = 'confirmed' WHERE id = $1`, [line.id]);
    }

    await client.query(
      `UPDATE stocktakes SET status = 'confirmed', confirmed_by = $1, confirmed_at = now() WHERE id = $2`,
      [userId, st.id]
    );

    await writeLog(client, {
      userId, targetTable: 'stocktakes', targetId: st.id, operationType: '棚卸し',
      before: { status: st.status },
      after: { confirmedLines, totalDiff, voidedBarcodes: voidedTotal, driftLines: drift.length, uncounted },
      facilityId: scope.facilityId,
    });

    await client.query('COMMIT');
    res.json({ ok: true, confirmedLines, totalDiff, voidedBarcodes: voidedTotal, drift, uncounted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('棚卸し確定エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// キャンセル(在庫は変更しない)
// ------------------------------------------------------------
router.post('/:id/cancel', async (req, res) => {
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してください' });
  const userId = req.session.user.id;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { st, error } = await loadStocktake(client, req.params.id, scope, true);
    if (error) { await client.query('ROLLBACK'); return res.status(error.status).json({ error: error.msg }); }
    if (!['open', 'counting'].includes(st.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'この棚卸しは既に確定またはキャンセルされています' });
    }
    await client.query(
      `UPDATE stocktakes SET status = 'canceled', canceled_at = now() WHERE id = $1`, [st.id]
    );
    await writeLog(client, {
      userId, targetTable: 'stocktakes', targetId: st.id, operationType: '棚卸し取消',
      before: { status: st.status }, after: { status: 'canceled' }, facilityId: scope.facilityId,
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('棚卸しキャンセルエラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
