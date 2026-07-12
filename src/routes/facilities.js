'use strict';

// 施設マスタ管理API (全体管理者=superadmin のみ。server.js で requireRole('superadmin'))
// 施設作成時に、その施設の初期管理者(メール+パスワード)も同時に作成する。
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, getClient } = require('../db');
const { writeLog } = require('../services/log');
const { isEmail } = require('../services/validate');
const { facilityNameTaken } = require('../services/facility');

const router = express.Router();

// 施設一覧(管理者数・プラン付き)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.kana, f.is_active, f.created_at, f.plan_code,
              f.billing_status, f.current_period_end, f.past_due_since,
              (f.stripe_subscription_id IS NOT NULL) AS has_subscription,
              pl.name AS plan_name, pl.max_users, pl.max_products, pl.price,
              (SELECT u3.login_id FROM users u3 WHERE u3.facility_id = f.id AND u3.user_type = 'admin' ORDER BY u3.id LIMIT 1) AS admin_email,
              (SELECT COUNT(*) FROM users u WHERE u.facility_id = f.id AND u.is_active = TRUE) AS user_count,
              (SELECT COUNT(*) FROM products p WHERE p.facility_id = f.id) AS product_count
         FROM facilities f
         LEFT JOIN plans pl ON pl.code = f.plan_code
        ORDER BY f.id`
    );
    res.json({ facilities: rows });
  } catch (err) {
    console.error('施設一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// プラン一覧(割当・編集用)
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM plans ORDER BY sort_order, code');
    res.json({ plans: rows });
  } catch (err) {
    console.error('プラン一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// プランの上限・機能を編集
// PUT /plans/:code
router.put('/plans/:code', async (req, res) => {
  const b = req.body || {};
  const LIMIT_COLS = ['max_users', 'max_products', 'log_retention_days'];
  const FEAT_COLS = ['feat_stocktake', 'feat_barcode', 'feat_reports', 'feat_ledger', 'feat_import', 'feat_billing'];
  const allowed = ['name', 'sort_order', 'price', 'stripe_price_id', ...LIMIT_COLS, ...FEAT_COLS];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (b[k] === undefined) continue;
    let v = b[k];
    if (LIMIT_COLS.includes(k)) {
      v = (v === '' || v === null) ? null : Number(v);   // 空=無制限(NULL)
      if (v !== null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: `${k} は0以上の数値または空(無制限)で入力してください` });
    } else if (FEAT_COLS.includes(k)) {
      v = !!v;
    } else if (k === 'sort_order') {
      v = Number(v) || 0;
    } else if (k === 'price') {
      v = Number(v) || 0;
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: '料金は0以上の数値で入力してください' });
    } else if (k === 'stripe_price_id') {
      v = (v === '' || v === null) ? null : String(v);   // 空=NULL
    } else {
      v = String(v);
    }
    params.push(v); sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: '変更項目がありません' });
  try {
    params.push(String(req.params.code));
    const r = await pool.query(
      `UPDATE plans SET ${sets.join(', ')}, updated_at = now() WHERE code = $${params.length} RETURNING code`, params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'プランが見つかりません' });
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'plans', targetId: null, operationType: '更新',
      after: { plan: req.params.code },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('プラン更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 施設の新規作成 + 初期管理者の作成
// POST /  body: { name, kana?, adminLoginId(email), adminPassword }
router.post('/', async (req, res) => {
  const { name, kana, adminLoginId, adminPassword, planCode } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '施設名は必須です' });
  if (!adminLoginId || !adminPassword) return res.status(400).json({ error: '管理者のログインID(メール)とパスワードは必須です' });
  if (!isEmail(adminLoginId)) return res.status(400).json({ error: 'ログインIDはメールアドレス形式で入力してください' });
  if (String(adminPassword).length < 8) return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    // ログインID(メール)の重複チェック
    const dup = await client.query('SELECT 1 FROM users WHERE login_id = $1', [adminLoginId]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'このログインID(メール)は既に使用されています' });
    }
    // 施設名の重複チェック
    if (await facilityNameTaken(client, name)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'この施設名は既に使用されています。別の施設名を入力してください。' });
    }
    // プラン(未指定/不明なら free)
    let plan = 'free';
    if (planCode) {
      const chk = await client.query('SELECT 1 FROM plans WHERE code = $1', [planCode]);
      if (chk.rowCount) plan = String(planCode);
    }
    const f = await client.query(
      `INSERT INTO facilities (name, kana, plan_code) VALUES ($1, $2, $3) RETURNING id, name`,
      [String(name).trim(), kana ? String(kana) : '', plan]
    );
    const facilityId = f.rows[0].id;
    // 伝票印字用の施設名(company_name)を施設名で初期化(後で設定画面から変更可)
    await client.query(
      `INSERT INTO app_settings (key, value, facility_id) VALUES ('company_name', $1, $2)
       ON CONFLICT (facility_id, key) DO NOTHING`,
      [String(name).trim(), facilityId]
    );
    // 初期管理者(初回ログイン時にパスワード変更必須)
    const hash = bcrypt.hashSync(String(adminPassword), 10);
    const u = await client.query(
      `INSERT INTO users (user_type, facility_id, name, kana, login_id, password_hash, must_change_password)
       VALUES ('admin', $1, $2, '', $3, $4, TRUE) RETURNING id`,
      [facilityId, name + ' 管理者', adminLoginId, hash]
    );
    await writeLog(client, {
      userId: req.session.user.id, targetTable: 'facilities', targetId: facilityId, operationType: '登録',
      after: { name: f.rows[0].name, admin_login_id: adminLoginId },
    });
    await client.query('COMMIT');
    res.status(201).json({ ok: true, facilityId, adminUserId: u.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('施設作成エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  } finally {
    client.release();
  }
});

// 施設の更新(名称・カナ・有効フラグ)
// PUT /:id  body: { name?, kana?, isActive? }
router.put('/:id', async (req, res) => {
  const { name, kana, isActive, planCode } = req.body || {};
  // 施設名を変更する場合は重複チェック(自分自身は除外)
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: '施設名は必須です' });
    if (await facilityNameTaken(pool, name, req.params.id)) {
      return res.status(409).json({ error: 'この施設名は既に使用されています。別の施設名を入力してください。' });
    }
  }
  const sets = [];
  const params = [];
  if (name !== undefined) { params.push(String(name)); sets.push(`name = $${params.length}`); }
  if (kana !== undefined) { params.push(String(kana)); sets.push(`kana = $${params.length}`); }
  if (isActive !== undefined) { params.push(!!isActive); sets.push(`is_active = $${params.length}`); }
  let beforePlan;
  if (planCode !== undefined) {
    const chk = await pool.query('SELECT 1 FROM plans WHERE code = $1', [planCode]);
    if (chk.rowCount === 0) return res.status(400).json({ error: '不明なプランです' });
    // 変更前プランを記録用に取得
    const cur = await pool.query('SELECT plan_code FROM facilities WHERE id = $1', [req.params.id]);
    beforePlan = cur.rowCount ? cur.rows[0].plan_code : null;
    params.push(String(planCode)); sets.push(`plan_code = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: '変更項目がありません' });
  try {
    params.push(req.params.id);
    const r = await pool.query(`UPDATE facilities SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
    if (r.rowCount === 0) return res.status(404).json({ error: '施設が見つかりません' });
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'facilities', targetId: req.params.id, operationType: '更新',
      after: { name, kana, is_active: isActive },
    });
    // プラン変更は専用ログに残す(全体管理者による変更)
    if (planCode !== undefined && String(planCode) !== String(beforePlan)) {
      await writeLog(pool, {
        userId: req.session.user.id, targetTable: 'facilities', targetId: req.params.id, operationType: 'プラン変更',
        before: { plan: beforePlan }, after: { plan: String(planCode), by: '全体管理者' }, facilityId: req.params.id,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('施設更新エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 全体管理者の操作対象施設を切り替え(セッションに保持)。null=全施設
// POST /activate  body: { facilityId }
router.post('/activate', async (req, res) => {
  const fid = req.body && req.body.facilityId;
  try {
    if (fid == null || fid === '') {
      req.session.activeFacilityId = null;
      return res.json({ ok: true, activeFacilityId: null });
    }
    const r = await pool.query('SELECT id FROM facilities WHERE id = $1 AND is_active = TRUE', [fid]);
    if (r.rowCount === 0) return res.status(404).json({ error: '施設が見つかりません' });
    req.session.activeFacilityId = Number(fid);
    res.json({ ok: true, activeFacilityId: Number(fid) });
  } catch (err) {
    console.error('施設切替エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
