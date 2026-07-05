'use strict';

const express = require('express');
const { pool, getClient } = require('../db');
const { applyStockChange, addOrderPlan, createUsageRecords, reverseIssue } = require('../services/inventory');
const { writeLog } = require('../services/log');
const { sendCsv } = require('../services/csv');
const { facilityScope } = require('../services/facility');

const router = express.Router();

// 履歴の編集・削除は管理者/一般のみ
function requireEditor(req, res, next) {
  const t = req.session.user && req.session.user.userType;
  if (t === 'admin' || t === 'general') return next();
  return res.status(403).json({ error: 'この操作の権限がありません' });
}

// 指定出庫が操作施設のものか(明細商品の所属施設で判定)
async function issueInFacility(db, issueId, scope) {
  if (!scope || scope.all) return true;
  const r = await db.query(
    `SELECT 1 FROM issues i
      WHERE i.id = $1 AND EXISTS (SELECT 1 FROM issue_details d JOIN products p ON p.id = d.product_id
                                   WHERE d.issue_id = i.id AND p.facility_id = $2)`,
    [issueId, scope.facilityId]
  );
  return r.rowCount > 0;
}

// 出庫登録
// body: {
//   issueDate, note?,
//   details: [
//     { barcodeValue }                                   // 独自バーコード出庫(バラ1個)
//     | { productId, productDetailId, lotNumber?, expiryDate?, issueQuantity, packSize } // 数量出庫
//   ]
// }
router.post('/', async (req, res) => {
  const userId = req.session.user.id;
  const { issueDate, note, details } = req.body || {};

  if (!issueDate || !Array.isArray(details) || details.length === 0) {
    return res.status(400).json({ error: '出庫日と明細は必須です' });
  }

  const scope = facilityScope(req);
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 期限切れ出庫の許可設定と当日日付を取得
    const setting = await client.query(`SELECT value FROM app_settings WHERE key = 'allow_expired_issue'`);
    const allowExpired = setting.rowCount ? String(setting.rows[0].value) === 'true' : false;
    const todayRow = await client.query(`SELECT CURRENT_DATE::text AS today`);
    const today = todayRow.rows[0].today;

    const iss = await client.query(
      `INSERT INTO issues (issue_date, user_id, note) VALUES ($1, $2, $3) RETURNING id`,
      [issueDate, userId, note || '']
    );
    const issueId = iss.rows[0].id;

    const processed = []; // 発注予定計算用

    for (const d of details) {
      let productId, productDetailId, lotNumber, expiryDate, issueQty, packSize, barcodeId = null;

      if (d.barcodeValue) {
        // 独自バーコード出庫: 個体を特定し、必ずバラ1個
        const bc = await client.query(
          `SELECT b.id, b.used_flag, b.voided_flag, b.product_id, rd.product_detail_id, rd.lot_number, rd.expiry_date
             FROM barcodes b
             JOIN receipt_details rd ON rd.id = b.receipt_detail_id
            WHERE b.barcode_value = $1
            FOR UPDATE OF b`,
          [d.barcodeValue]
        );
        if (bc.rowCount === 0) {
          throw Object.assign(new Error(`バーコードが見つかりません: ${d.barcodeValue}`), { status: 400 });
        }
        if (bc.rows[0].voided_flag) {
          throw Object.assign(new Error(`無効化されたバーコードです: ${d.barcodeValue}`), { status: 400 });
        }
        if (bc.rows[0].used_flag) {
          throw Object.assign(new Error(`使用済みのバーコードです: ${d.barcodeValue}`), { status: 400 });
        }
        barcodeId = bc.rows[0].id;
        productId = bc.rows[0].product_id;
        productDetailId = bc.rows[0].product_detail_id;
        lotNumber = bc.rows[0].lot_number || '';
        expiryDate = bc.rows[0].expiry_date || null;
        issueQty = 1;
        packSize = 1;
      } else {
        if (!d.productId || !d.issueQuantity || !d.packSize) {
          throw Object.assign(new Error('明細に商品ID・出庫個数・梱包数は必須です'), { status: 400 });
        }
        productId = d.productId;
        productDetailId = d.productDetailId || null;
        lotNumber = d.lotNumber || '';
        expiryDate = d.expiryDate || null;
        issueQty = d.issueQuantity;
        packSize = d.packSize;
      }

      // 施設スコープ: 対象商品(バーコード/数量いずれも)が操作施設のものか確認
      if (!scope.all) {
        const pf = await client.query('SELECT facility_id FROM products WHERE id = $1', [productId]);
        if (pf.rowCount === 0 || String(pf.rows[0].facility_id) !== String(scope.facilityId)) {
          throw Object.assign(new Error('対象施設外の商品が含まれています'), { status: 400 });
        }
      }

      // 期限切れ出庫の制御 (許可設定がfalseなら保存不可)
      if (!allowExpired && expiryDate && expiryDate < today) {
        throw Object.assign(
          new Error(`期限切れの商品は出庫できません (期限:${expiryDate})`),
          { status: 400 }
        );
      }

      // 出庫明細 (出庫合計数は生成列)
      const det = await client.query(
        `INSERT INTO issue_details
           (issue_id, product_id, product_detail_id, lot_number, expiry_date,
            issue_quantity, pack_size, barcode_id, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, issue_total_quantity`,
        [issueId, productId, productDetailId, lotNumber, expiryDate,
         issueQty, packSize, barcodeId, d.note || '']
      );
      const issueDetailId = det.rows[0].id;
      const totalBara = Number(det.rows[0].issue_total_quantity);

      // 在庫減算 (不足時は例外→ロールバック)
      await applyStockChange(client, {
        productId, lotNumber, expiryDate,
        delta: -totalBara, movementType: 'issue',
        relatedId: issueId, userId, issueDate,
      });

      // バーコード出庫なら使用済み + 使用開始日(=出庫日)
      if (barcodeId) {
        await client.query(
          `UPDATE barcodes SET used_flag = TRUE, use_start_date = $1 WHERE id = $2`,
          [issueDate, barcodeId]
        );
      } else if (productDetailId) {
        // 数量出庫: 試薬管理対象かつバーコード発行OFFの商品は使用記録を作成(使用開始日=出庫日)
        const flags = await client.query(
          `SELECT p.qc_target_flag, pd.barcode_issue_flag
             FROM product_details pd JOIN products p ON p.id = pd.product_id
            WHERE pd.id = $1`,
          [productDetailId]
        );
        if (flags.rowCount && flags.rows[0].qc_target_flag && !flags.rows[0].barcode_issue_flag) {
          await createUsageRecords(client, {
            productId, lotNumber, expiryDate, count: totalBara, useStartDate: issueDate, issueId,
          });
        }
      }

      processed.push({ issueDetailId, productId, productDetailId, issuePieceQty: totalBara });
    }

    // 問屋・梱包数を商品詳細から取得
    for (const p of processed) {
      if (p.productDetailId) {
        const pd = await client.query(
          `SELECT supplier_id, pack_size FROM product_details WHERE id = $1`,
          [p.productDetailId]
        );
        if (pd.rowCount) {
          p.supplierId = pd.rows[0].supplier_id;
          p.packSize = Number(pd.rows[0].pack_size);
        }
      }
    }

    // 問屋混在チェック: 発注予定は問屋単位。複数問屋が混在したら自動作成しない。
    const suppliers = [...new Set(processed.filter((p) => p.supplierId).map((p) => String(p.supplierId)))];
    let orderPlanCreated = false;
    let message = null;

    if (suppliers.length > 1) {
      message = '複数の問屋の商品が混在しているため、発注予定は自動作成しませんでした。';
    } else if (suppliers.length === 1) {
      for (const p of processed) {
        if (!p.supplierId) continue;
        await addOrderPlan(client, {
          issueDetailId: p.issueDetailId,
          productId: p.productId,
          productDetailId: p.productDetailId,
          supplierId: p.supplierId,
          packSize: p.packSize,
          issuePieceQty: p.issuePieceQty,
          userId,
        });
      }
      orderPlanCreated = true;
    }

    await writeLog(client, {
      userId, targetTable: 'issues', targetId: issueId, operationType: '登録',
      after: { issueDate, detailCount: processed.length, orderPlanCreated },
    });

    await client.query('COMMIT');
    res.status(201).json({ issueId, orderPlanCreated, message });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('出庫登録エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 出庫履歴一覧 (from/to/商品/キーワード)
// GET /api/issues?from=&to=&productId=&query=
async function queryIssueList(q, scope) {
  const { from, to, productId, query } = q;
  const limit = Math.min(Number(q.limit) || 500, 2000);
  const params = [];
  let cond = '1 = 1';
  if (scope && !scope.all) { params.push(scope.facilityId); cond += ` AND EXISTS (SELECT 1 FROM issue_details d JOIN products p ON p.id = d.product_id WHERE d.issue_id = i.id AND p.facility_id = $${params.length})`; }
  if (from) { params.push(from); cond += ` AND i.issue_date >= $${params.length}`; }
  if (to) { params.push(to); cond += ` AND i.issue_date <= $${params.length}`; }
  if (productId) { params.push(productId); cond += ` AND EXISTS (SELECT 1 FROM issue_details d WHERE d.issue_id = i.id AND d.product_id = $${params.length})`; }
  if (query) { params.push('%' + query + '%'); cond += ` AND (i.note ILIKE $${params.length} OR EXISTS (SELECT 1 FROM issue_details d JOIN products p ON p.id = d.product_id WHERE d.issue_id = i.id AND p.name ILIKE $${params.length}))`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT i.id, i.issue_date, i.note, i.created_at, u.name AS user_name,
            (SELECT COUNT(*) FROM issue_details d WHERE d.issue_id = i.id) AS detail_count,
            (SELECT COALESCE(SUM(d.issue_total_quantity), 0) FROM issue_details d WHERE d.issue_id = i.id) AS total_bara
       FROM issues i
       LEFT JOIN users u ON u.id = i.user_id
      WHERE ${cond}
      ORDER BY i.id DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

router.get('/', async (req, res) => {
  try {
    res.json({ issues: await queryIssueList(req.query, facilityScope(req)) });
  } catch (err) {
    console.error('出庫履歴エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 出庫履歴CSV
// GET /api/issues/csv
router.get('/csv', async (req, res) => {
  try {
    const rows = await queryIssueList(req.query, facilityScope(req));
    const columns = [
      { key: 'id', label: 'ID' },
      { key: 'issue_date', label: '出庫日' },
      { key: 'detail_count', label: '明細件数' },
      { key: 'total_bara', label: 'バラ計' },
      { key: 'note', label: '備考' },
      { key: 'user_name', label: '担当' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'issues', operationType: 'CSV出力',
      after: { file: '出庫履歴.csv', count: rows.length },
    });
    sendCsv(res, '出庫履歴.csv', columns, rows);
  } catch (err) {
    console.error('出庫履歴CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 出庫明細
// GET /api/issues/:id
router.get('/:id', async (req, res) => {
  const scope = facilityScope(req);
  try {
    if (!(await issueInFacility(pool, req.params.id, scope))) return res.status(404).json({ error: '出庫が見つかりません' });
    const head = await pool.query(
      `SELECT i.id, i.issue_date, i.note, i.created_at, u.name AS user_name
         FROM issues i LEFT JOIN users u ON u.id = i.user_id
        WHERE i.id = $1`,
      [req.params.id]
    );
    if (head.rowCount === 0) return res.status(404).json({ error: '出庫が見つかりません' });
    const details = await pool.query(
      `SELECT d.id, d.product_id, p.name AS product_name, d.product_detail_id,
              d.lot_number, d.expiry_date, d.issue_quantity, d.pack_size,
              d.issue_total_quantity, d.barcode_id, b.barcode_value, d.note
         FROM issue_details d
         JOIN products p ON p.id = d.product_id
         LEFT JOIN barcodes b ON b.id = d.barcode_id
        WHERE d.issue_id = $1
        ORDER BY d.id`,
      [req.params.id]
    );
    res.json({ issue: head.rows[0], details: details.rows });
  } catch (err) {
    console.error('出庫明細エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 出庫の編集(備考・出庫日のみ)。出庫日変更は使用開始日(バーコード/使用記録)にも連動。
// PATCH /api/issues/:id  body: { note?, issueDate? }
router.patch('/:id', requireEditor, async (req, res) => {
  const { note, issueDate } = req.body || {};
  const scope = facilityScope(req);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (!(await issueInFacility(client, req.params.id, scope))) { await client.query('ROLLBACK'); return res.status(404).json({ error: '出庫が見つかりません' }); }
    const cur = await client.query(`SELECT id, issue_date, note FROM issues WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: '出庫が見つかりません' }); }
    const oldDate = cur.rows[0].issue_date;
    const newDate = issueDate || oldDate;
    const newNote = note != null ? note : cur.rows[0].note;

    await client.query(`UPDATE issues SET issue_date = $1, note = $2 WHERE id = $3`, [newDate, newNote, req.params.id]);

    // 出庫日変更時: この出庫のバーコード・使用記録の使用開始日を連動更新(未終了のもの)
    if (issueDate && newDate !== oldDate) {
      await client.query(
        `UPDATE barcodes SET use_start_date = $1
          WHERE id IN (SELECT barcode_id FROM issue_details WHERE issue_id = $2 AND barcode_id IS NOT NULL)`,
        [newDate, req.params.id]
      );
      await client.query(
        `UPDATE usage_records SET use_start_date = $1 WHERE issue_id = $2`,
        [newDate, req.params.id]
      );
    }
    await writeLog(client, {
      userId: req.session.user.id, targetTable: 'issues', targetId: req.params.id, operationType: '更新',
      before: { issue_date: oldDate, note: cur.rows[0].note }, after: { issue_date: newDate, note: newNote },
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('出庫編集エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 出庫の削除(巻き戻し)
// DELETE /api/issues/:id
router.delete('/:id', requireEditor, async (req, res) => {
  const scope = facilityScope(req);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (!(await issueInFacility(client, req.params.id, scope))) { await client.query('ROLLBACK'); return res.status(404).json({ error: '出庫が見つかりません' }); }
    const before = await client.query(`SELECT issue_date, note FROM issues WHERE id = $1`, [req.params.id]);
    await reverseIssue(client, req.params.id, req.session.user.id);
    await writeLog(client, {
      userId: req.session.user.id, targetTable: 'issues', targetId: req.params.id, operationType: '削除',
      before: before.rows[0] || null,
    });
    await client.query('COMMIT');
    res.json({ ok: true, message: '出庫を削除しました（在庫・バーコード・発注予定を巻き戻しました）' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('出庫削除エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
