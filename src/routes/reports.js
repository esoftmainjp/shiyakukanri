'use strict';

// 集計API (使用量集計・月次推移)。管理者/一般。server.js で requireRole 済み。
// 金額の考え方:
//   出庫金額 = Σ(出庫個数[入力単位] × 商品詳細の単価)  ※単価は取引(入力)単位あたり
//   入庫金額 = Σ(入庫個数[入力単位] × 入庫時点の単価スナップショット)
//   数量は原則バラ個数(最小単位)で表示する。
const express = require('express');
const { pool } = require('../db');
const { sendCsv } = require('../services/csv');
const { writeLog } = require('../services/log');

const router = express.Router();

// 期間の既定(未指定時)
function range(q) {
  return { from: q.from || '0001-01-01', to: q.to || '9999-12-31' };
}

// 使用量集計(出庫)。groupBy: product | department | category。問屋/メーカーで絞り込み可。
function usageQuery(q) {
  const groupBy = ['product', 'department', 'category'].includes(q.groupBy) ? q.groupBy : 'product';
  const { from, to } = range(q);
  const params = [from, to];
  let gjoin = '';
  let gid = 'p.id';
  let gname = 'p.name';
  if (groupBy === 'department') {
    gjoin = 'LEFT JOIN departments dep ON dep.id = p.department_id';
    gid = 'dep.id'; gname = "COALESCE(dep.name, '(未設定)')";
  } else if (groupBy === 'category') {
    gjoin = 'LEFT JOIN categories cat ON cat.id = p.category_id';
    gid = 'cat.id'; gname = "COALESCE(cat.name, '(未設定)')";
  }
  let cond = 'i.issue_date >= $1 AND i.issue_date <= $2';
  if (q.supplierId) { params.push(q.supplierId); cond += ` AND pd.supplier_id = $${params.length}`; }
  if (q.makerId) { params.push(q.makerId); cond += ` AND pd.maker_id = $${params.length}`; }
  const sql = `
    SELECT ${gid} AS group_id, ${gname} AS group_name,
           string_agg(DISTINCT s.name, ', ') AS supplier_names,
           string_agg(DISTINCT mk.name, ', ') AS maker_names,
           COALESCE(SUM(d.issue_total_quantity), 0) AS quantity,
           COALESCE(SUM(d.issue_quantity * COALESCE(pd.unit_price, 0)), 0) AS amount,
           COUNT(*) AS line_count
      FROM issue_details d
      JOIN issues i ON i.id = d.issue_id
      JOIN products p ON p.id = d.product_id
      LEFT JOIN product_details pd ON pd.id = d.product_detail_id
      LEFT JOIN suppliers s ON s.id = pd.supplier_id
      LEFT JOIN makers mk ON mk.id = pd.maker_id
      ${gjoin}
     WHERE ${cond}
     GROUP BY ${gid}, ${gname}
     ORDER BY amount DESC, quantity DESC`;
  return { sql, params, groupBy };
}

const GROUP_LABEL = { product: '商品', department: '部門', category: '分類' };

async function fetchUsage(q) {
  const { sql, params, groupBy } = usageQuery(q);
  const { from, to } = range(q);
  const { rows } = await pool.query(sql, params);
  const total = rows.reduce((a, r) => ({
    quantity: a.quantity + Number(r.quantity),
    amount: a.amount + Number(r.amount),
    line_count: a.line_count + Number(r.line_count),
  }), { quantity: 0, amount: 0, line_count: 0 });
  return { rows, total, groupBy, from, to };
}

// GET /api/reports/usage?from&to&groupBy
router.get('/usage', async (req, res) => {
  try {
    const r = await fetchUsage(req.query);
    res.json(r);
  } catch (err) {
    console.error('使用量集計エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// GET /api/reports/usage/csv
router.get('/usage/csv', async (req, res) => {
  try {
    const r = await fetchUsage(req.query);
    const label = GROUP_LABEL[r.groupBy] || '商品';
    const data = r.rows.map((x) => ({
      group_name: x.group_name, supplier_names: x.supplier_names || '', maker_names: x.maker_names || '',
      quantity: x.quantity, amount: x.amount, line_count: x.line_count,
    }));
    data.push({ group_name: '合計', supplier_names: '', maker_names: '', quantity: r.total.quantity, amount: r.total.amount, line_count: r.total.line_count });
    const columns = [
      { key: 'group_name', label },
      { key: 'supplier_names', label: '問屋' },
      { key: 'maker_names', label: 'メーカー' },
      { key: 'quantity', label: '使用量(バラ)' },
      { key: 'amount', label: '金額' },
      { key: 'line_count', label: '明細件数' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'issues', operationType: 'CSV出力',
      after: { file: '使用量集計.csv', groupBy: r.groupBy, count: r.rows.length },
    });
    sendCsv(res, '使用量集計.csv', columns, data);
  } catch (err) {
    console.error('使用量集計CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 月次推移(入庫・出庫を月別に集計)
async function fetchMonthly(q) {
  const { from, to } = range(q);
  const recp = await pool.query(
    `SELECT to_char(r.receipt_date, 'YYYY-MM') AS ym,
            COALESCE(SUM(rd.stock_added_quantity), 0) AS qty,
            COALESCE(SUM(rd.receipt_quantity * rd.unit_price), 0) AS amount
       FROM receipt_details rd
       JOIN receipts r ON r.id = rd.receipt_id
      WHERE r.receipt_date >= $1 AND r.receipt_date <= $2
      GROUP BY ym`, [from, to]);
  const iss = await pool.query(
    `SELECT to_char(i.issue_date, 'YYYY-MM') AS ym,
            COALESCE(SUM(d.issue_total_quantity), 0) AS qty,
            COALESCE(SUM(d.issue_quantity * COALESCE(pd.unit_price, 0)), 0) AS amount
       FROM issue_details d
       JOIN issues i ON i.id = d.issue_id
       LEFT JOIN product_details pd ON pd.id = d.product_detail_id
      WHERE i.issue_date >= $1 AND i.issue_date <= $2
      GROUP BY ym`, [from, to]);

  const map = {};
  const get = (ym) => (map[ym] || (map[ym] = { ym, receipt_qty: 0, receipt_amount: 0, issue_qty: 0, issue_amount: 0 }));
  recp.rows.forEach((r) => { const m = get(r.ym); m.receipt_qty = Number(r.qty); m.receipt_amount = Number(r.amount); });
  iss.rows.forEach((r) => { const m = get(r.ym); m.issue_qty = Number(r.qty); m.issue_amount = Number(r.amount); });
  const rows = Object.values(map).sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
  return { rows, from, to };
}

// GET /api/reports/monthly?from&to
router.get('/monthly', async (req, res) => {
  try {
    res.json(await fetchMonthly(req.query));
  } catch (err) {
    console.error('月次推移エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// GET /api/reports/monthly/csv
router.get('/monthly/csv', async (req, res) => {
  try {
    const r = await fetchMonthly(req.query);
    const columns = [
      { key: 'ym', label: '年月' },
      { key: 'receipt_qty', label: '入庫量(バラ)' },
      { key: 'receipt_amount', label: '入庫金額' },
      { key: 'issue_qty', label: '出庫量(バラ)' },
      { key: 'issue_amount', label: '出庫金額' },
    ];
    await writeLog(pool, {
      userId: req.session.user && req.session.user.id,
      targetTable: 'issues', operationType: 'CSV出力',
      after: { file: '月次推移.csv', count: r.rows.length },
    });
    sendCsv(res, '月次推移.csv', columns, r.rows);
  } catch (err) {
    console.error('月次推移CSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
