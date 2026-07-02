'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { writeLog } = require('./services/log');

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
      `SELECT id, user_type, name, login_id, password_hash
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
    };
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

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ user: req.session.user });
});

// ------------------------------------------------------------
// サンプル: 在庫一覧 (ログイン必須)
// ------------------------------------------------------------
app.get('/api/stocks', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, p.name AS product_name, s.lot_number, s.expiry_date, s.stock_quantity
         FROM product_stocks s
         JOIN products p ON p.id = s.product_id
        ORDER BY p.name, s.expiry_date NULLS LAST`
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
app.use('/api/receipts',  requireLogin, requireRole('admin', 'general', 'supplier'), require('./routes/receipts'));
app.use('/api/orders',    requireLogin, requireRole('admin', 'general', 'supplier'), require('./routes/orders'));
app.use('/api/issues',    requireLogin, requireRole('admin', 'general'), require('./routes/issues'));
app.use('/api/inventory', requireLogin, requireRole('admin', 'general'), require('./routes/inventory'));
app.use('/api/barcodes',  requireLogin, requireRole('admin', 'general'), require('./routes/barcodes'));
app.use('/api/ledger',    requireLogin, requireRole('admin', 'general'), require('./routes/ledger'));
app.use('/api/masters',   requireLogin, requireRole('admin'), require('./routes/masters'));
app.use('/api/import',    requireLogin, requireRole('admin'), require('./routes/import'));

// ------------------------------------------------------------
// 静的ファイル (public/ があれば配信)
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`試薬在庫管理システム サーバー起動: http://localhost:${PORT}`);
});

module.exports = { app, requireLogin, requireRole };
