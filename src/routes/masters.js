'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { writeLog } = require('../services/log');

const router = express.Router();

// 各マスターの設定 (列はホワイトリスト。SQLインジェクション防止)
const TYPES = {
  suppliers:   { table: 'suppliers',   cols: ['name', 'kana', 'note', 'is_active'], hasActive: true },
  makers:      { table: 'makers',      cols: ['name', 'kana', 'jan_maker_code', 'note', 'is_active'], hasActive: true },
  departments: { table: 'departments', cols: ['name', 'kana', 'note', 'is_active'], hasActive: true },
  categories:  { table: 'categories',  cols: ['name', 'kana', 'note', 'is_active'], hasActive: true },
  products:    { table: 'products',    cols: ['name', 'kana', 'department_id', 'category_id', 'management_code', 'qc_target_flag', 'note', 'is_active'], hasActive: true },
  'product-details': {
    table: 'product_details',
    cols: ['product_id', 'apply_start_date', 'apply_end_date', 'quantity_unit', 'pack_size', 'pack_unit',
      'spec', 'unit_price', 'test_count', 'min_quantity', 'order_quantity', 'jan_code',
      'maker_id', 'supplier_id', 'barcode_issue_flag', 'note'],
    hasActive: false,
  },
  users: { table: 'users', cols: ['user_type', 'name', 'kana', 'login_id', 'note', 'is_active'], hasActive: true },
};

function getType(req, res) {
  const t = TYPES[req.params.type];
  if (!t) { res.status(404).json({ error: '不明なマスター種別です' }); return null; }
  return t;
}

// 一覧
router.get('/:type', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  try {
    // usersはパスワードハッシュを返さない
    const select = t.table === 'users'
      ? 'id, user_type, name, kana, login_id, note, is_active, password_updated_at, created_at, updated_at'
      : '*';
    const { rows } = await pool.query(`SELECT ${select} FROM ${t.table} ORDER BY id`);
    res.json({ rows });
  } catch (err) {
    console.error('マスター一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 登録
router.post('/:type', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  const body = req.body || {};
  try {
    const cols = [];
    const vals = [];
    for (const c of t.cols) {
      if (body[c] !== undefined) { cols.push(c); vals.push(body[c]); }
    }
    // ユーザーはパスワードをハッシュ化して追加
    if (t.table === 'users') {
      if (!body.password) return res.status(400).json({ error: 'パスワードは必須です' });
      cols.push('password_hash');
      vals.push(bcrypt.hashSync(String(body.password), 10));
      cols.push('password_updated_at');
      vals.push(new Date());
    }
    if (cols.length === 0) return res.status(400).json({ error: '登録項目がありません' });

    const ph = vals.map((_, i) => '$' + (i + 1)).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
      vals
    );
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: t.table, targetId: rows[0].id, operationType: '登録',
    });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('マスター登録エラー:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// 更新
router.put('/:type/:id', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  const body = req.body || {};
  try {
    const sets = [];
    const vals = [];
    for (const c of t.cols) {
      if (body[c] !== undefined) { vals.push(body[c]); sets.push(`${c} = $${vals.length}`); }
    }
    if (t.table === 'users' && body.password) {
      vals.push(bcrypt.hashSync(String(body.password), 10));
      sets.push(`password_hash = $${vals.length}`);
      vals.push(new Date());
      sets.push(`password_updated_at = $${vals.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: '更新項目がありません' });

    vals.push(req.params.id);
    const { rowCount } = await pool.query(
      `UPDATE ${t.table} SET ${sets.join(', ')} WHERE id = $${vals.length}`,
      vals
    );
    if (rowCount === 0) return res.status(404).json({ error: '対象が見つかりません' });
    const safe = { ...body }; delete safe.password;
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: t.table, targetId: req.params.id, operationType: '更新', after: safe,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('マスター更新エラー:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// 有効/無効の切替 (論理削除)
router.post('/:type/:id/toggle', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  if (!t.hasActive) return res.status(400).json({ error: 'この種別は有効フラグを持ちません' });
  try {
    const { rows } = await pool.query(
      `UPDATE ${t.table} SET is_active = NOT is_active WHERE id = $1 RETURNING is_active`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '対象が見つかりません' });
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: t.table, targetId: req.params.id,
      operationType: '更新', after: { is_active: rows[0].is_active },
    });
    res.json({ ok: true, isActive: rows[0].is_active });
  } catch (err) {
    console.error('マスター切替エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
