'use strict';

const express = require('express');
const { getClient } = require('../db');
const { applyStockChange, addOrderPlan, createUsageRecords } = require('../services/inventory');
const { writeLog } = require('../services/log');

const router = express.Router();

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
          `SELECT b.id, b.used_flag, b.product_id, rd.product_detail_id, rd.lot_number, rd.expiry_date
             FROM barcodes b
             JOIN receipt_details rd ON rd.id = b.receipt_detail_id
            WHERE b.barcode_value = $1
            FOR UPDATE OF b`,
          [d.barcodeValue]
        );
        if (bc.rowCount === 0) {
          throw Object.assign(new Error(`バーコードが見つかりません: ${d.barcodeValue}`), { status: 400 });
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
            issue_quantity, pack_size, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, issue_total_quantity`,
        [issueId, productId, productDetailId, lotNumber, expiryDate,
         issueQty, packSize, d.note || '']
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

module.exports = router;
