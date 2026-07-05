'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { writeLog } = require('../services/log');
const { isEmail } = require('../services/validate');
const { facilityScope } = require('../services/facility');

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

// 物理削除時の参照チェック定義(このマスタを参照する側のテーブル・カラム・表示名)。
// 1件でも参照があれば削除をブロックする。
const REFERENCES = {
  suppliers: [
    { table: 'product_details', col: 'supplier_id', label: '商品詳細' },
    { table: 'orders', col: 'supplier_id', label: '発注' },
    { table: 'receipts', col: 'supplier_id', label: '入庫' },
  ],
  makers: [
    { table: 'product_details', col: 'maker_id', label: '商品詳細' },
  ],
  departments: [
    { table: 'products', col: 'department_id', label: '商品' },
  ],
  categories: [
    { table: 'products', col: 'category_id', label: '商品' },
  ],
  products: [
    { table: 'product_details', col: 'product_id', label: '商品詳細' },
    { table: 'product_stocks', col: 'product_id', label: '在庫' },
    { table: 'receipt_details', col: 'product_id', label: '入庫明細' },
    { table: 'issue_details', col: 'product_id', label: '出庫明細' },
    { table: 'order_details', col: 'product_id', label: '発注明細' },
    { table: 'barcodes', col: 'product_id', label: 'バーコード' },
    { table: 'stock_movements', col: 'product_id', label: '在庫移動' },
    { table: 'usage_records', col: 'product_id', label: '使用記録' },
  ],
  'product-details': [
    { table: 'receipt_details', col: 'product_detail_id', label: '入庫明細' },
    { table: 'issue_details', col: 'product_detail_id', label: '出庫明細' },
    { table: 'order_details', col: 'product_detail_id', label: '発注明細' },
  ],
  users: [
    { table: 'receipts', col: 'user_id', label: '入庫' },
    { table: 'issues', col: 'user_id', label: '出庫' },
    { table: 'orders', col: 'user_id', label: '発注' },
    { table: 'stock_movements', col: 'user_id', label: '在庫移動' },
    { table: 'operation_logs', col: 'user_id', label: '操作ログ' },
  ],
};

// 一覧 (施設スコープ。全体管理者が施設未選択なら全施設横断)
router.get('/:type', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  const scope = facilityScope(req);
  try {
    // usersはパスワードハッシュを返さない
    const select = t.table === 'users'
      ? 'id, user_type, name, kana, login_id, note, is_active, password_updated_at, created_at, updated_at'
      : '*';
    const params = [];
    let where = '';
    if (!scope.all) { params.push(scope.facilityId); where = 'WHERE facility_id = $1'; }
    const { rows } = await pool.query(`SELECT ${select} FROM ${t.table} ${where} ORDER BY id`, params);
    res.json({ rows });
  } catch (err) {
    console.error('マスター一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 登録 (対象施設に紐付け。全体管理者は施設未選択だと不可)
router.post('/:type', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  const scope = facilityScope(req);
  if (scope.all) return res.status(400).json({ error: '対象施設を選択してから登録してください' });
  const body = req.body || {};
  try {
    const cols = [];
    const vals = [];
    for (const c of t.cols) {
      if (body[c] !== undefined) { cols.push(c); vals.push(body[c]); }
    }
    if (cols.length === 0 && t.table !== 'users') return res.status(400).json({ error: '登録項目がありません' });
    // 所属施設を付与(全マスタ共通)
    cols.push('facility_id'); vals.push(scope.facilityId);
    // ユーザーはパスワードをハッシュ化して追加
    if (t.table === 'users') {
      if (!body.password) return res.status(400).json({ error: 'パスワードは必須です' });
      if (!isEmail(body.login_id)) return res.status(400).json({ error: 'ログインIDはメールアドレス形式で入力してください' });
      // ログインIDは全施設で重複不可。事前チェックで分かりやすく案内。
      const dup = await pool.query('SELECT 1 FROM users WHERE login_id = $1', [body.login_id]);
      if (dup.rowCount) return res.status(400).json({ error: 'このログインID(メール)は既に使用されています' });
      cols.push('password_hash');
      vals.push(bcrypt.hashSync(String(body.password), 10));
      cols.push('password_updated_at');
      vals.push(new Date());
      // 管理者が設定した初期パスワードは、本人の初回ログイン時に変更を必須とする
      cols.push('must_change_password');
      vals.push(true);
    }

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
    if (err.code === '23505') {
      const msg = /login_id/.test(err.constraint || '') ? 'このログインID(メール)は既に使用されています' : '同じ値が既に登録されています（重複）';
      return res.status(400).json({ error: msg });
    }
    res.status(400).json({ error: err.message });
  }
});

// 更新 (対象施設の行のみ。全体管理者が施設未選択なら全施設対象)
router.put('/:type/:id', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  const scope = facilityScope(req);
  const body = req.body || {};
  try {
    if (t.table === 'users' && body.login_id !== undefined) {
      if (!isEmail(body.login_id)) {
        return res.status(400).json({ error: 'ログインIDはメールアドレス形式で入力してください' });
      }
      const dup = await pool.query('SELECT 1 FROM users WHERE login_id = $1 AND id <> $2', [body.login_id, req.params.id]);
      if (dup.rowCount) return res.status(400).json({ error: 'このログインID(メール)は既に使用されています' });
    }
    const sets = [];
    const vals = [];
    const changedCols = [];
    for (const c of t.cols) {
      if (body[c] !== undefined) { vals.push(body[c]); sets.push(`${c} = $${vals.length}`); changedCols.push(c); }
    }
    // 変更前の値(変更対象カラムのみ)を取得してログに残す
    let beforeObj = {};
    if (changedCols.length) {
      const gvals = [req.params.id];
      let gwhere = 'id = $1';
      if (!scope.all) { gvals.push(scope.facilityId); gwhere += ' AND facility_id = $2'; }
      const cur = await pool.query(`SELECT ${changedCols.join(', ')} FROM ${t.table} WHERE ${gwhere}`, gvals);
      if (cur.rowCount) beforeObj = cur.rows[0];
    }
    if (t.table === 'users' && body.password) {
      vals.push(bcrypt.hashSync(String(body.password), 10));
      sets.push(`password_hash = $${vals.length}`);
      vals.push(new Date());
      sets.push(`password_updated_at = $${vals.length}`);
      // 管理者がパスワードを再設定した場合も、本人の次回ログイン時に変更を必須とする
      vals.push(true);
      sets.push(`must_change_password = $${vals.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: '更新項目がありません' });

    vals.push(req.params.id);
    let where = `id = $${vals.length}`;
    if (!scope.all) { vals.push(scope.facilityId); where += ` AND facility_id = $${vals.length}`; }
    const { rowCount } = await pool.query(
      `UPDATE ${t.table} SET ${sets.join(', ')} WHERE ${where}`,
      vals
    );
    if (rowCount === 0) return res.status(404).json({ error: '対象が見つかりません' });
    // 変更後(変更対象カラムのみ)。パスワードはハッシュを残さず「(変更)」と記録。
    const afterObj = {};
    for (const c of changedCols) afterObj[c] = body[c];
    if (t.table === 'users' && body.password) afterObj.password = '(変更)';
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: t.table, targetId: req.params.id, operationType: '更新',
      before: beforeObj, after: afterObj,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('マスター更新エラー:', err.message);
    if (err.code === '23505') {
      const msg = /login_id/.test(err.constraint || '') ? 'このログインID(メール)は既に使用されています' : '同じ値が既に登録されています（重複）';
      return res.status(400).json({ error: msg });
    }
    res.status(400).json({ error: err.message });
  }
});

// 有効/無効の切替 (論理削除)
router.post('/:type/:id/toggle', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  if (!t.hasActive) return res.status(400).json({ error: 'この種別は有効フラグを持ちません' });
  const scope = facilityScope(req);
  try {
    const vals = [req.params.id];
    let where = 'id = $1';
    if (!scope.all) { vals.push(scope.facilityId); where += ' AND facility_id = $2'; }
    const { rows } = await pool.query(
      `UPDATE ${t.table} SET is_active = NOT is_active WHERE ${where} RETURNING is_active`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: '対象が見つかりません' });
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: t.table, targetId: req.params.id,
      operationType: '更新', before: { is_active: !rows[0].is_active }, after: { is_active: rows[0].is_active },
    });
    res.json({ ok: true, isActive: rows[0].is_active });
  } catch (err) {
    console.error('マスター切替エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 物理削除。既存データから参照されている場合はブロックして理由を返す。
// DELETE /:type/:id
router.delete('/:type/:id', async (req, res) => {
  const t = getType(req, res); if (!t) return;
  const scope = facilityScope(req);
  const id = req.params.id;
  try {
    // 対象の存在・施設スコープ確認
    const chkVals = [id];
    let chkWhere = 'id = $1';
    if (!scope.all) { chkVals.push(scope.facilityId); chkWhere += ' AND facility_id = $2'; }
    const exist = await pool.query(`SELECT id FROM ${t.table} WHERE ${chkWhere}`, chkVals);
    if (exist.rowCount === 0) return res.status(404).json({ error: '対象が見つかりません' });

    // 参照チェック(1件でもあれば削除不可)
    const used = [];
    for (const ref of (REFERENCES[req.params.type] || [])) {
      const c = await pool.query(`SELECT COUNT(*) AS c FROM ${ref.table} WHERE ${ref.col} = $1`, [id]);
      const n = Number(c.rows[0].c);
      if (n > 0) used.push(`${ref.label}${n}件`);
    }
    if (used.length) {
      return res.status(409).json({
        error: `既存データで使用中のため削除できません（${used.join('・')}）。不要な場合は「無効化」してください。`,
      });
    }

    const delVals = [id];
    let delWhere = 'id = $1';
    if (!scope.all) { delVals.push(scope.facilityId); delWhere += ' AND facility_id = $2'; }
    const r = await pool.query(`DELETE FROM ${t.table} WHERE ${delWhere} RETURNING id`, delVals);
    if (r.rowCount === 0) return res.status(404).json({ error: '対象が見つかりません' });
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: t.table, targetId: id, operationType: '削除',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('マスター削除エラー:', err.message);
    res.status(500).json({ error: err.message || 'サーバーエラー' });
  }
});

module.exports = router;
