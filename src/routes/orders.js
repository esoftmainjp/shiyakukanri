'use strict';

const express = require('express');
const { pool, getClient } = require('../db');
const { writeLog } = require('../services/log');
const { refreshOrderReceiptStatus } = require('../services/inventory');

const router = express.Router();

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 履歴の編集・削除は管理者/一般のみ
function requireEditor(req, res, next) {
  const t = req.session.user && req.session.user.userType;
  if (t === 'admin' || t === 'general') return next();
  return res.status(403).json({ error: 'この操作の権限がありません' });
}

// 発注一覧 (状態で絞り込み可)。明細も付与する。
// GET /api/orders?status=unordered
router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE o.order_status = $1';
    }
    const orders = await pool.query(
      `SELECT o.id, o.order_date, o.supplier_id, s.name AS supplier_name,
              o.order_status, o.note
         FROM orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         ${where}
        ORDER BY o.id DESC`,
      params
    );
    const details = await pool.query(
      `SELECT od.id, od.order_id, od.product_id, p.name AS product_name,
              od.product_detail_id, od.planned_order_quantity, od.order_quantity, od.note,
              COALESCE(pd.pack_size, 1) AS pack_size,
              COALESCE((SELECT SUM(op.issue_piece_quantity) FROM order_plans op WHERE op.order_detail_id = od.id), 0) AS order_bara
         FROM order_details od
         JOIN products p ON p.id = od.product_id
         LEFT JOIN product_details pd ON pd.id = od.product_detail_id
        ORDER BY od.id`
    );
    const byOrder = {};
    for (const d of details.rows) {
      (byOrder[d.order_id] ||= []).push(d);
    }
    const result = orders.rows.map((o) => ({ ...o, details: byOrder[o.id] || [] }));
    res.json({ orders: result });
  } catch (err) {
    console.error('発注一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ホーム用サマリー: 発注予定(未発注)と入庫予定(発注済み・未入庫)
// GET /api/orders/summary
router.get('/summary', async (req, res) => {
  try {
    // 発注予定(未発注): これから発注する分
    const plans = await pool.query(
      `SELECT o.id AS order_id, o.supplier_id, s.name AS supplier_name,
              od.id AS order_detail_id, p.name AS product_name,
              od.planned_order_quantity, od.order_quantity,
              COALESCE(pd.pack_size, 1) AS pack_size
         FROM orders o
         JOIN order_details od ON od.order_id = o.id
         JOIN products p ON p.id = od.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN product_details pd ON pd.id = od.product_detail_id
        WHERE o.order_status = 'unordered' AND od.order_quantity > 0
        ORDER BY s.name, p.name`
    );

    // 入庫予定(発注済み・未入庫): これから入ってくる分(残バラ数>0)
    const incoming = await pool.query(
      `SELECT o.id AS order_id, o.order_date, o.supplier_id, s.name AS supplier_name,
              p.name AS product_name, od.order_quantity,
              COALESCE(pd.pack_size, 1) AS pack_size,
              COALESCE((SELECT SUM(rp.receipt_piece_quantity) FROM receipt_plans rp WHERE rp.order_detail_id = od.id), 0) AS received_bara
         FROM orders o
         JOIN order_details od ON od.order_id = o.id
         JOIN products p ON p.id = od.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN product_details pd ON pd.id = od.product_detail_id
        WHERE o.order_status = 'ordered'
        ORDER BY o.order_date, s.name, p.name`
    );
    const receiptPlans = incoming.rows.map((r) => {
      const orderedBara = Number(r.order_quantity) * Number(r.pack_size);
      return { ...r, ordered_bara: orderedBara, remaining_bara: orderedBara - Number(r.received_bara) };
    }).filter((r) => r.remaining_bara > 0);

    res.json({ orderPlans: plans.rows, receiptPlans });
  } catch (err) {
    console.error('発注サマリーエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 発注明細詳細
// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  try {
    const head = await pool.query(
      `SELECT o.id, o.order_date, o.supplier_id, s.name AS supplier_name,
              o.order_status, o.note, o.created_at, u.name AS user_name
         FROM orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN users u ON u.id = o.user_id
        WHERE o.id = $1`,
      [req.params.id]
    );
    if (head.rowCount === 0) return res.status(404).json({ error: '発注が見つかりません' });
    const details = await pool.query(
      `SELECT od.id, od.product_id, p.name AS product_name, od.product_detail_id,
              od.planned_order_quantity, od.order_quantity, od.note,
              COALESCE(pd.pack_size, 1) AS pack_size,
              COALESCE((SELECT SUM(rp.receipt_piece_quantity) FROM receipt_plans rp WHERE rp.order_detail_id = od.id), 0) AS received_bara
         FROM order_details od
         JOIN products p ON p.id = od.product_id
         LEFT JOIN product_details pd ON pd.id = od.product_detail_id
        WHERE od.order_id = $1
        ORDER BY od.id`,
      [req.params.id]
    );
    res.json({ order: head.rows[0], details: details.rows });
  } catch (err) {
    console.error('発注明細エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 発注処理: 未発注 → 発注済み
// POST /api/orders/:id/place  body: { orderDate? }
router.post('/:id/place', async (req, res) => {
  const orderId = req.params.id;
  const orderDate = (req.body && req.body.orderDate) || today();
  const note = (req.body && req.body.note) || '';
  try {
    const r = await pool.query(
      `UPDATE orders SET order_status = 'ordered', order_date = $2, note = $3
        WHERE id = $1 AND order_status = 'unordered'
        RETURNING id`,
      [orderId, orderDate, note]
    );
    if (r.rowCount === 0) {
      return res.status(400).json({ error: '未発注の発注のみ発注処理できます' });
    }
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'orders', targetId: orderId,
      operationType: '更新', before: { order_status: 'unordered' }, after: { order_status: 'ordered', order_date: orderDate },
    });
    res.json({ ok: true, orderId, orderStatus: 'ordered' });
  } catch (err) {
    console.error('発注処理エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// キャンセル: 未発注 or 発注済み → キャンセル
// POST /api/orders/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const orderId = req.params.id;
  try {
    const r = await pool.query(
      `UPDATE orders SET order_status = 'canceled'
        WHERE id = $1 AND order_status IN ('unordered', 'ordered')
        RETURNING id`,
      [orderId]
    );
    if (r.rowCount === 0) {
      return res.status(400).json({ error: 'この発注はキャンセルできません' });
    }
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'orders', targetId: orderId,
      operationType: '更新', after: { order_status: 'canceled' },
    });
    res.json({ ok: true, orderId, orderStatus: 'canceled' });
  } catch (err) {
    console.error('発注キャンセルエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 発注明細の商品追加: その発注の問屋の商品のみ許可(異問屋は拒否)
// POST /api/orders/:id/details  body: { productId, productDetailId, orderQuantity }
router.post('/:id/details', async (req, res) => {
  const orderId = req.params.id;
  const { productId, productDetailId, orderQuantity } = req.body || {};
  if (!productId || !productDetailId) {
    return res.status(400).json({ error: '商品IDと商品詳細IDは必須です' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const ord = await client.query(
      `SELECT supplier_id, order_status FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (ord.rowCount === 0) {
      throw Object.assign(new Error('発注が見つかりません'), { status: 404 });
    }
    if (ord.rows[0].order_status !== 'unordered') {
      throw Object.assign(new Error('未発注の発注のみ商品を追加できます'), { status: 400 });
    }

    const pd = await client.query(
      `SELECT supplier_id FROM product_details WHERE id = $1`,
      [productDetailId]
    );
    if (pd.rowCount === 0) {
      throw Object.assign(new Error('商品詳細が見つかりません'), { status: 400 });
    }

    // 問屋チェック: 発注の問屋と一致しなければ追加不可
    if (String(pd.rows[0].supplier_id) !== String(ord.rows[0].supplier_id)) {
      throw Object.assign(
        new Error('発注情報の問屋と異なる問屋の商品は追加できません'),
        { status: 400 }
      );
    }

    const qty = Number(orderQuantity) || 1;
    const ins = await client.query(
      `INSERT INTO order_details (order_id, product_id, product_detail_id, planned_order_quantity, order_quantity)
       VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [orderId, productId, productDetailId, qty]
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, orderDetailId: ins.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('発注明細追加エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 発注明細の発注数を変更(未発注のみ)
// PATCH /api/orders/:id/details/:detailId  body: { orderQuantity }
router.patch('/:id/details/:detailId', async (req, res) => {
  const { id: orderId, detailId } = req.params;
  const qty = Math.max(1, Number(req.body && req.body.orderQuantity) || 1);
  try {
    const ord = await pool.query(`SELECT order_status FROM orders WHERE id = $1`, [orderId]);
    if (ord.rowCount === 0) return res.status(404).json({ error: '発注が見つかりません' });
    if (ord.rows[0].order_status !== 'unordered') {
      return res.status(400).json({ error: '未発注の発注のみ発注数を変更できます' });
    }
    const r = await pool.query(
      `UPDATE order_details SET order_quantity = $1 WHERE id = $2 AND order_id = $3 RETURNING id`,
      [qty, detailId, orderId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '発注明細が見つかりません' });
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'order_details', targetId: detailId,
      operationType: '更新', after: { order_quantity: qty },
    });
    res.json({ ok: true, orderQuantity: qty });
  } catch (err) {
    console.error('発注数変更エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 発注明細(商品行)の削除/キャンセル。未発注・発注済みのみ。入庫済みの明細は不可。
// DELETE /api/orders/:id/details/:detailId
router.delete('/:id/details/:detailId', requireEditor, async (req, res) => {
  const { id: orderId, detailId } = req.params;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const ord = await client.query(`SELECT order_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (ord.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: '発注が見つかりません' }); }
    const status = ord.rows[0].order_status;
    if (status !== 'unordered' && status !== 'ordered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'この発注の商品は削除できません' });
    }
    const od = await client.query(`SELECT id FROM order_details WHERE id = $1 AND order_id = $2`, [detailId, orderId]);
    if (od.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: '発注明細が見つかりません' }); }

    // 入庫済み(部分入庫含む)の商品は削除不可
    const rp = await client.query(`SELECT COUNT(*) AS c FROM receipt_plans WHERE order_detail_id = $1`, [detailId]);
    if (Number(rp.rows[0].c) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'この商品は入庫済みのため削除できません' });
    }

    // 発注予定(order_plans)→発注明細 の順に削除
    await client.query(`DELETE FROM order_plans WHERE order_detail_id = $1`, [detailId]);
    await client.query(`DELETE FROM order_details WHERE id = $1`, [detailId]);

    // 残明細が無ければ発注ごと削除。発注済みで残りが全て入庫済みなら状態を更新。
    const remain = await client.query(`SELECT COUNT(*) AS c FROM order_details WHERE order_id = $1`, [orderId]);
    let orderDeleted = false;
    if (Number(remain.rows[0].c) === 0) {
      await client.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      orderDeleted = true;
    } else if (status === 'ordered') {
      await refreshOrderReceiptStatus(client, orderId);
    }

    await writeLog(client, {
      userId: req.session.user.id, targetTable: 'order_details', targetId: detailId, operationType: '削除',
      before: { order_id: orderId, order_status: status },
    });
    await client.query('COMMIT');
    res.json({ ok: true, orderDeleted, message: '商品を発注から削除しました' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('発注明細削除エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 発注の編集(備考・発注日のみ)
// PATCH /api/orders/:id  body: { note?, orderDate? }
router.patch('/:id', requireEditor, async (req, res) => {
  const { note, orderDate } = req.body || {};
  try {
    const cur = await pool.query(`SELECT id, order_date, note FROM orders WHERE id = $1`, [req.params.id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '発注が見つかりません' });
    const newDate = (orderDate !== undefined && orderDate !== '') ? orderDate : cur.rows[0].order_date;
    const newNote = note != null ? note : cur.rows[0].note;
    await pool.query(`UPDATE orders SET order_date = $1, note = $2 WHERE id = $3`, [newDate, newNote, req.params.id]);
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'orders', targetId: req.params.id, operationType: '更新',
      before: { order_date: cur.rows[0].order_date, note: cur.rows[0].note }, after: { order_date: newDate, note: newNote },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('発注編集エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 発注の削除
// DELETE /api/orders/:id  ブロック条件: 入庫予定(receipt_plans)が紐付く(入庫済み)
router.delete('/:id', requireEditor, async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT id, order_status, note FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: '発注が見つかりません' }); }

    const rp = await client.query(
      `SELECT COUNT(*) AS c FROM receipt_plans rp
         JOIN order_details od ON od.id = rp.order_detail_id
        WHERE od.order_id = $1`,
      [req.params.id]
    );
    if (Number(rp.rows[0].c) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '入庫済みの発注は削除できません' });
    }

    // 発注予定(order_plans)→発注明細→発注 の順に削除
    await client.query(
      `DELETE FROM order_plans WHERE order_detail_id IN (SELECT id FROM order_details WHERE order_id = $1)`,
      [req.params.id]
    );
    await client.query(`DELETE FROM order_details WHERE order_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM orders WHERE id = $1`, [req.params.id]);
    await writeLog(client, {
      userId: req.session.user.id, targetTable: 'orders', targetId: req.params.id, operationType: '削除',
      before: { order_status: cur.rows[0].order_status, note: cur.rows[0].note },
    });
    await client.query('COMMIT');
    res.json({ ok: true, message: '発注を削除しました' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('発注削除エラー:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  } finally {
    client.release();
  }
});

module.exports = router;
