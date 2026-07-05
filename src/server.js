'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { writeLog } = require('./services/log');
const { getSetting } = require('./routes/settings');
const { facilityScope } = require('./services/facility');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 本番(Render)ではプロキシ配下のためsecure cookieを有効化できるようにする
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8時間
    },
  })
);

// ------------------------------------------------------------
// 認証ミドルウェア
// ------------------------------------------------------------
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  next();
}

// 権限チェック (許可するuser_typeの配列を渡す)
function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return res.status(401).json({ error: 'ログインが必要です' });
    if (!roles.includes(user.userType)) {
      return res.status(403).json({ error: 'この操作の権限がありません' });
    }
    next();
  };
}

// ------------------------------------------------------------
// ヘルスチェック
// ------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    console.error('ヘルスチェック失敗:', err);
    res.status(500).json({ ok: false, db: 'error' });
  }
});

// ------------------------------------------------------------
// ログイン / ログアウト / 現在ユーザー
// ------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) {
    return res.status(400).json({ error: 'ログインIDとパスワードは必須です' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, user_type, name, login_id, password_hash, must_change_password, facility_id
         FROM users
        WHERE login_id = $1 AND is_active = TRUE`,
      [loginId]
    );
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });
    }

    req.session.user = {
      id: user.id,
      userType: user.user_type,
      name: user.name,
      loginId: user.login_id,
      facilityId: user.facility_id,
      mustChangePassword: user.must_change_password === true,
    };
    // 全体管理者は施設を選択して操作(既定は未選択=全施設)。一般ユーザーは所属施設に固定。
    req.session.activeFacilityId = (user.user_type === 'superadmin') ? null : user.facility_id;
    await writeLog(pool, { userId: user.id, targetTable: 'users', targetId: user.id, operationType: 'ログイン' });
    res.json({ user: req.session.user });
  } catch (err) {
    console.error('ログイン処理エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireLogin, async (req, res) => {
  // パスワード有効期限(日)の設定に基づき、期限切れを判定(0=無効)
  let passwordExpired = false;
  let passwordExpiryDays = 0;
  let daysSinceChange = null;
  try {
    passwordExpiryDays = Number(await getSetting('password_expiry_days', '0', facilityScope(req).facilityId)) || 0;
    if (passwordExpiryDays > 0) {
      const { rows } = await pool.query('SELECT password_updated_at FROM users WHERE id = $1', [req.session.user.id]);
      if (rows.length && rows[0].password_updated_at) {
        daysSinceChange = Math.floor((Date.now() - new Date(rows[0].password_updated_at).getTime()) / 86400000);
        passwordExpired = daysSinceChange >= passwordExpiryDays;
      }
    }
  } catch (err) {
    console.error('パスワード期限判定エラー:', err.message);
  }

  // 施設コンテキスト
  const isSuper = req.session.user.userType === 'superadmin';
  let facilities = [];
  let activeFacilityId = req.session.activeFacilityId != null ? req.session.activeFacilityId : null;
  let facilityName = null;
  try {
    if (isSuper) {
      const { rows } = await pool.query('SELECT id, name FROM facilities WHERE is_active = TRUE ORDER BY name');
      facilities = rows;
      if (activeFacilityId != null) {
        const f = rows.find((r) => String(r.id) === String(activeFacilityId));
        facilityName = f ? f.name : null;
      }
    } else if (req.session.user.facilityId != null) {
      activeFacilityId = req.session.user.facilityId;
      const { rows } = await pool.query('SELECT name FROM facilities WHERE id = $1', [activeFacilityId]);
      facilityName = rows.length ? rows[0].name : null;
    }
  } catch (err) {
    console.error('施設情報取得エラー:', err.message);
  }

  res.json({
    user: req.session.user, passwordExpired, passwordExpiryDays, daysSinceChange,
    isSuperadmin: isSuper, facilities, activeFacilityId, facilityName,
  });
});

// 本人のパスワード情報(最終変更日時)を取得
app.get('/api/me/password-info', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT password_updated_at FROM users WHERE id = $1`,
      [req.session.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    res.json({ passwordUpdatedAt: rows[0].password_updated_at });
  } catch (err) {
    console.error('パスワード情報取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 本人によるパスワード変更 (全ロール)
// POST /api/me/password  body: { currentPassword, newPassword }
app.post('/api/me/password', requireLogin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '現在のパスワードと新しいパスワードは必須です' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: '新しいパスワードは8文字以上にしてください' });
  }
  if (String(newPassword) === String(currentPassword)) {
    return res.status(400).json({ error: '現在のパスワードと異なるパスワードを設定してください' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1 AND is_active = TRUE`,
      [req.session.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (!bcrypt.compareSync(String(currentPassword), rows[0].password_hash)) {
      return res.status(400).json({ error: '現在のパスワードが違います' });
    }
    const hash = bcrypt.hashSync(String(newPassword), 10);
    const upd = await pool.query(
      `UPDATE users SET password_hash = $1, password_updated_at = now(), must_change_password = FALSE
        WHERE id = $2 RETURNING password_updated_at`,
      [hash, req.session.user.id]
    );
    // セッションの要変更フラグも解除
    req.session.user.mustChangePassword = false;
    await writeLog(pool, {
      userId: req.session.user.id, targetTable: 'users', targetId: req.session.user.id,
      operationType: '更新', after: { password_changed: true },
    });
    res.json({ ok: true, passwordUpdatedAt: upd.rows[0].password_updated_at });
  } catch (err) {
    console.error('パスワード変更エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 印刷・CSV出力などクライアント側で完結する操作を操作ログに記録する
// POST /api/activity  body: { action, targetTable?, targetId?, detail? }
app.post('/api/activity', requireLogin, async (req, res) => {
  const ALLOWED = { print: '印刷', csv: 'CSV出力', 'barcode-print': 'バーコード印刷' };
  const { action, targetTable, targetId, detail } = req.body || {};
  const op = ALLOWED[action];
  if (!op) return res.status(400).json({ error: '不正な操作種別です' });
  const tid = (targetId != null && targetId !== '' && !isNaN(Number(targetId))) ? Number(targetId) : null;
  await writeLog(pool, {
    userId: req.session.user.id,
    targetTable: String(targetTable || ''),
    targetId: tid,
    operationType: op,
    after: (detail && typeof detail === 'object') ? detail : (detail != null ? { detail } : null),
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// サンプル: 在庫一覧 (ログイン必須)
// ------------------------------------------------------------
app.get('/api/stocks', requireLogin, async (req, res) => {
  try {
    const scope = facilityScope(req);
    const params = [];
    let where = '';
    if (!scope.all) { params.push(scope.facilityId); where = 'WHERE p.facility_id = $1'; }
    const { rows } = await pool.query(
      `SELECT s.id, p.name AS product_name, s.lot_number, s.expiry_date, s.stock_quantity
         FROM product_stocks s
         JOIN products p ON p.id = s.product_id
        ${where}
        ORDER BY p.name, s.expiry_date NULLS LAST`,
      params
    );
    res.json({ stocks: rows });
  } catch (err) {
    console.error('在庫一覧取得エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ------------------------------------------------------------
// 業務API (要ログイン)
// ------------------------------------------------------------
// 権限方針:
//   admin    : 全機能
//   general  : 入庫・出庫・発注・在庫管理・使用終了日・台帳
//   supplier : 入庫・発注のみ
app.use('/api/lookup',    requireLogin, require('./routes/lookup'));
app.use('/api/settings',  requireLogin, require('./routes/settings'));
// 全体管理者(superadmin)は施設を選択している間、その施設の管理者と同等に操作できる。
app.use('/api/receipts',  requireLogin, requireRole('admin', 'general', 'supplier', 'superadmin'), require('./routes/receipts'));
app.use('/api/orders',    requireLogin, requireRole('admin', 'general', 'supplier', 'superadmin'), require('./routes/orders'));
app.use('/api/issues',    requireLogin, requireRole('admin', 'general', 'superadmin'), require('./routes/issues'));
app.use('/api/inventory', requireLogin, requireRole('admin', 'general', 'superadmin'), require('./routes/inventory'));
app.use('/api/barcodes',  requireLogin, requireRole('admin', 'general', 'superadmin'), require('./routes/barcodes'));
app.use('/api/ledger',    requireLogin, requireRole('admin', 'general', 'superadmin'), require('./routes/ledger'));
app.use('/api/reports',   requireLogin, requireRole('admin', 'general', 'superadmin'), require('./routes/reports'));
app.use('/api/facilities', requireLogin, requireRole('superadmin'), require('./routes/facilities'));
app.use('/api/masters',   requireLogin, requireRole('admin', 'superadmin'), require('./routes/masters'));
app.use('/api/import',    requireLogin, requireRole('admin', 'superadmin'), require('./routes/import'));
app.use('/api/logs',      requireLogin, requireRole('admin', 'superadmin'), require('./routes/logs'));

// ------------------------------------------------------------
// 取扱説明書(PDF)。ログインユーザーが閲覧可能。
// ------------------------------------------------------------
app.get('/manual.pdf', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'docs', '取扱説明書.pdf'));
});

// ------------------------------------------------------------
// 静的ファイル (public/ があれば配信)
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`試薬在庫管理システム サーバー起動: http://localhost:${PORT}`);
});

module.exports = { app, requireLogin, requireRole };
