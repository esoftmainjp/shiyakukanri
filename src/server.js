'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const { writeLog } = require('./services/log');
const { getSetting } = require('./routes/settings');
const { facilityScope } = require('./services/facility');
const { als } = require('./services/context');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// セキュリティHTTPヘッダ(クリックジャッキング防止・MIMEスニッフィング防止など)。
// 本アプリはインラインscript/onclick属性を多用するため、CSPは無効化して他ヘッダのみ有効化する。
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 本番(Render)ではプロキシ配下のためsecure cookieを有効化できるようにする
if (isProd) {
  app.set('trust proxy', 1);
}

// セッション署名鍵。本番で未設定/既定値のままだとCookie偽造の恐れがあるため、
// その場合は起動ごとにランダム鍵を使う(既知の鍵での運用を防ぐ。再起動で全セッション失効)。
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'change-this-secret') {
  if (isProd) {
    console.warn('[security] SESSION_SECRET が未設定/既定値です。起動ごとのランダム鍵を使用します。恒久運用のため環境変数 SESSION_SECRET を設定してください。');
    sessionSecret = crypto.randomBytes(32).toString('hex');
  } else {
    sessionSecret = 'local-dev-secret';
  }
}

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax', // CSRF緩和(クロスサイトからのCookie送信を抑制)
      maxAge: 1000 * 60 * 60 * 8, // 8時間
    },
  })
);

// ログイン試行のレート制限(ブルートフォース対策)。IP単位で一定回数まで。
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ログイン試行が多すぎます。しばらくしてから再度お試しください。' },
});

// リクエスト単位の操作施設をコンテキストに保持(操作ログの施設付与に使用)。
// ここでは現在のセッションの操作施設を格納する(未ログインや未選択はNULL)。
app.use((req, res, next) => {
  let facilityId = null;
  try { facilityId = facilityScope(req).facilityId; } catch (e) { facilityId = null; }
  als.run({ facilityId }, () => next());
});

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

// プラン機能ゲート: 施設のプランで当該機能が無効なら 403。
// 全体管理者(superadmin)と施設未選択は制限しない。
function requireFeature(featKey) {
  const { getFacilityPlan } = require('./services/plan');
  return async (req, res, next) => {
    try {
      const user = req.session && req.session.user;
      if (user && user.userType === 'superadmin') return next();
      const scope = facilityScope(req);
      if (scope.all || scope.facilityId == null) return next();
      const plan = await getFacilityPlan(pool, scope.facilityId);
      if (plan && plan[featKey] === false) {
        return res.status(403).json({ error: 'この機能は現在のプランではご利用いただけません。上位プランへの変更をご検討ください。' });
      }
      next();
    } catch (err) {
      console.error('プラン機能判定エラー:', err.message);
      next(); // 判定失敗時は可用性優先で通す
    }
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
// 広告LP(別ホストの静的サイト)からのお問い合わせ受付（公開・要ログインなし）
//   Resend(HTTPS API)でメール送信。RenderはSMTPを遮断するためHTTP APIを使う。
//   許可オリジンは CONTACT_ORIGINS(カンマ区切り)で限定。未設定なら全許可
//   （レート制限＋ハニーポットで防御）。
// ------------------------------------------------------------
const CONTACT_ORIGINS = (process.env.CONTACT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function contactCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && (CONTACT_ORIGINS.length === 0 || CONTACT_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // helmetの既定(same-origin)を上書き
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: '送信が多すぎます。しばらくしてから再度お試しください。' },
});
const contactOneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
async function sendContactMail({ from, to, replyTo, subject, text }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, reply_to: replyTo, subject, text }),
  });
  if (!r.ok) { const b = await r.text().catch(() => ''); const e = new Error(`Resend ${r.status}: ${b}`); e.status = r.status; throw e; }
  return r.json();
}
app.options('/api/contact', contactCors);
app.post('/api/contact', contactCors, contactLimiter, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // ハニーポット
  const org = contactOneLine(b.org), name = contactOneLine(b.name), email = contactOneLine(b.email);
  const tel = contactOneLine(b.tel), type = contactOneLine(b.type);
  const body = String(b.body == null ? '' : b.body).trim();
  if (!org || !name || !email || !body) return res.status(400).json({ error: '必須項目が未入力です。' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません。' });
  if (body.length > 5000) return res.status(400).json({ error: 'お問い合わせ内容が長すぎます。' });
  if (!process.env.RESEND_API_KEY) { console.error('RESEND_API_KEY 未設定'); return res.status(500).json({ error: '送信設定が未構成です。お手数ですがお電話ください。' }); }
  const to = process.env.MAIL_TO || 'info@e-soft.jp';
  const from = process.env.MAIL_FROM || 'onboarding@resend.dev';
  try {
    await sendContactMail({
      from: from, to: to, replyTo: email,
      subject: `【試薬在庫管理システム】お問い合わせ（${type || '—'}）: ${org}`,
      text:
        `試薬在庫管理システムのLPからお問い合わせがありました。\n\n` +
        `種別　　　: ${type || '（未選択）'}\n会社/施設名: ${org}\nお名前　　: ${name}\n` +
        `メール　　: ${email}\n電話　　　: ${tel || '（未入力）'}\n` +
        `----------------------------------------\n${body}\n`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('お問い合わせメール送信エラー:', err.status || '', err.message);
    res.status(500).json({ error: '送信に失敗しました。時間をおいて再度お試しください。' });
  }
});

// ------------------------------------------------------------
// ログイン / ログアウト / 現在ユーザー
// ------------------------------------------------------------
app.post('/api/login', loginLimiter, async (req, res) => {
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
    // 所属施設が無効化されている利用者はログイン不可(全体管理者=施設なしは対象外)
    if (user.facility_id != null) {
      const f = await pool.query('SELECT is_active FROM facilities WHERE id = $1', [user.facility_id]);
      if (f.rowCount === 0 || f.rows[0].is_active === false) {
        return res.status(403).json({ error: 'この施設は現在利用できません（無効化されています）。管理者にお問い合わせください。' });
      }
    }

    // セッション固定攻撃対策: 認証成功時にセッションIDを再生成する
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));

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
    // ログインのログはその利用者の施設に記録(コンテキストは未ログイン時のためNULLになるため明示)
    await writeLog(pool, { userId: user.id, facilityId: user.facility_id, targetTable: 'users', targetId: user.id, operationType: 'ログイン' });
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

  // 施設のプラン(上限・機能フラグ)。施設選択時のみ。全体管理者が未選択なら null(全機能)。
  let plan = null;
  try {
    if (activeFacilityId != null) {
      const { getFacilityPlan } = require('./services/plan');
      plan = await getFacilityPlan(pool, activeFacilityId);
    }
  } catch (err) {
    console.error('プラン取得エラー:', err.message);
  }

  res.json({
    user: req.session.user, passwordExpired, passwordExpiryDays, daysSinceChange,
    isSuperadmin: isSuper, facilities, activeFacilityId, facilityName, plan,
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
app.use('/api/stocktake', requireLogin, requireRole('admin', 'general', 'superadmin'), requireFeature('feat_stocktake'), require('./routes/stocktake'));
app.use('/api/barcodes',  requireLogin, requireRole('admin', 'general', 'superadmin'), requireFeature('feat_barcode'), require('./routes/barcodes'));
app.use('/api/ledger',    requireLogin, requireRole('admin', 'general', 'superadmin'), requireFeature('feat_ledger'), require('./routes/ledger'));
app.use('/api/reports',   requireLogin, requireRole('admin', 'general', 'superadmin'), requireFeature('feat_reports'), require('./routes/reports'));
app.use('/api/billing',   requireLogin, requireRole('admin', 'superadmin'), requireFeature('feat_billing'), require('./routes/billing'));
app.use('/api/facilities', requireLogin, requireRole('superadmin'), require('./routes/facilities'));
app.use('/api/db-usage',  requireLogin, requireRole('superadmin'), require('./routes/db-usage'));
app.use('/api/masters',   requireLogin, requireRole('admin', 'superadmin'), require('./routes/masters'));
app.use('/api/import',    requireLogin, requireRole('admin', 'superadmin'), requireFeature('feat_import'), require('./routes/import'));
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

// ------------------------------------------------------------
// 起動処理
//   AUTO_MIGRATE=1 のとき、起動時に未適用のマイグレーションを自動適用する。
//   ローカルはもちろん、本番(Render)も環境変数 AUTO_MIGRATE=1 を設定すれば
//   デプロイ(再起動)時に自動適用される。マイグレーションは追跡型(schema_migrations)・
//   冪等・トランザクションのため、既適用分はスキップされ安全。
//   万一失敗してもサーバー自体は起動する(ログに記録)。
// ------------------------------------------------------------
async function start() {
  if (process.env.AUTO_MIGRATE === '1') {
    try {
      const { syncMigrations } = require('../scripts/migrate-runner');
      const { applied } = await syncMigrations(pool, (m) => console.log(m));
      console.log(applied.length
        ? `[migrate] DBを更新しました(${applied.length}件): ${applied.join(', ')}`
        : '[migrate] DBは最新です');
    } catch (err) {
      // 失敗してもサーバー自体は起動する(ログで検知)
      console.error('[migrate] 自動マイグレーション失敗:', err.message);
    }
  }
  app.listen(PORT, () => {
    console.log(`試薬在庫管理システム サーバー起動: http://localhost:${PORT}`);
  });
  // プランの保持日数を超えた操作ログを定期削除(起動時＋24時間毎)。無制限(NULL)は対象外。
  pruneOldLogs();
  setInterval(pruneOldLogs, 24 * 60 * 60 * 1000);
}

// プラン(施設)の log_retention_days を超えた operation_logs を削除する。
async function pruneOldLogs() {
  try {
    const r = await pool.query(
      `DELETE FROM operation_logs ol
         USING facilities f
         JOIN plans p ON p.code = f.plan_code
        WHERE ol.facility_id = f.id
          AND p.log_retention_days IS NOT NULL
          AND ol.created_at < now() - (p.log_retention_days || ' days')::interval`
    );
    if (r.rowCount) console.log(`[retention] 保持期間超過の操作ログを削除: ${r.rowCount}件`);
  } catch (err) {
    console.error('[retention] ログ保持期間の適用に失敗:', err.message);
  }
}

start();

module.exports = { app, requireLogin, requireRole };
