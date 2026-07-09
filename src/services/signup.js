'use strict';

// セルフ利用登録の中核サービス。
// ・completeSignup: 申込保留(signup_requests)から施設＋初期管理者を自動作成し、
//   パスワード設定トークンを発行する(Webhook/疑似決済/無料即時 で共用。冪等)。
// ・パスワード設定トークンの発行/検証/消費。

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getClient, pool } = require('../db');
const { writeLog } = require('./log');
const { sendMail } = require('./mail');
const { facilityNameTaken } = require('./facility');

const TOKEN_TTL_HOURS = 48;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function appBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    return `${proto}://${req.get('host')}`;
  }
  return 'http://localhost:' + (process.env.PORT || 3000);
}

// パスワード設定トークンを発行(生トークンを返す。DBにはハッシュのみ保存)。
async function issueSetupToken(db, userId, purpose = 'setup') {
  const raw = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO password_setup_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)`,
    [userId, sha256(raw), purpose, String(TOKEN_TTL_HOURS)]
  );
  return raw;
}

// 施設＋初期管理者を作成(トランザクション内)。パスワードは未設定(ランダム不明値)にし、
// 設定リンクで本人が後から設定する。戻り: { facilityId, adminUserId }
async function createFacilityWithAdmin(client, { facilityName, email, planCode }) {
  const name = String(facilityName).trim();
  // 施設名の重複は不可(トランザクション内で最終確認)
  if (await facilityNameTaken(client, name)) {
    const e = new Error('この施設名は既に使用されています'); e.status = 409; throw e;
  }
  const f = await client.query(
    `INSERT INTO facilities (name, kana, plan_code) VALUES ($1, '', $2) RETURNING id`,
    [name, planCode]
  );
  const facilityId = f.rows[0].id;
  await client.query(
    `INSERT INTO app_settings (key, value, facility_id) VALUES ('company_name', $1, $2)
     ON CONFLICT (facility_id, key) DO NOTHING`,
    [name, facilityId]
  );
  // パスワードは推測不能なランダム値でハッシュ(設定リンクで確定するまでログイン不可)
  const placeholder = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
  const u = await client.query(
    `INSERT INTO users (user_type, facility_id, name, kana, login_id, password_hash, must_change_password)
     VALUES ('admin', $1, $2, '', $3, $4, TRUE) RETURNING id`,
    [facilityId, name + ' 管理者', email, placeholder]
  );
  return { facilityId, adminUserId: u.rows[0].id };
}

// 申込を完了させ、施設＋管理者を作成し、設定トークンを発行してメール送信する。
// Webhook/疑似決済/無料即時 から共用。既に完了済みならそのまま返す(冪等)。
// billing: { customerId?, subscriptionId?, currentPeriodEnd?, status? }
// 戻り: { facilityId, adminUserId, token, email, alreadyDone }
async function completeSignup(reqId, billing = {}, { req = null } = {}) {
  const client = await getClient();
  let facilityId, adminUserId, token, email, planCode, facilityName, alreadyDone = false;
  try {
    await client.query('BEGIN');
    const sr = await client.query('SELECT * FROM signup_requests WHERE id = $1 FOR UPDATE', [reqId]);
    if (sr.rowCount === 0) { await client.query('ROLLBACK'); const e = new Error('申込が見つかりません'); e.status = 404; throw e; }
    const request = sr.rows[0];
    email = request.email;
    planCode = request.plan_code;
    facilityName = request.facility_name;

    if (request.status === 'completed' && request.facility_id) {
      // 冪等: 既に作成済み。トークンは再発行せず終了。
      alreadyDone = true;
      facilityId = request.facility_id;
      await client.query('COMMIT');
      return { facilityId, adminUserId: null, token: null, email, planCode, alreadyDone };
    }

    // 既存ログインID(メール)との重複は作成不可
    const dup = await client.query('SELECT 1 FROM users WHERE login_id = $1', [email]);
    if (dup.rowCount > 0) {
      await client.query('UPDATE signup_requests SET status = $2 WHERE id = $1', [reqId, 'error']);
      await client.query('COMMIT');
      const e = new Error('このメールアドレスは既に登録されています'); e.status = 409; throw e;
    }

    const created = await createFacilityWithAdmin(client, { facilityName: request.facility_name, email, planCode });
    facilityId = created.facilityId;
    adminUserId = created.adminUserId;

    // 施設の課金状態を反映
    await client.query(
      `UPDATE facilities
          SET stripe_customer_id = $2, stripe_subscription_id = $3,
              billing_status = $4, current_period_end = $5
        WHERE id = $1`,
      [facilityId, billing.customerId || null, billing.subscriptionId || null,
       billing.status || (billing.subscriptionId ? 'active' : 'none'),
       billing.currentPeriodEnd || null]
    );

    token = await issueSetupToken(client, adminUserId, 'setup');

    await client.query(
      `UPDATE signup_requests
          SET status = 'completed', facility_id = $2, completed_at = now(),
              stripe_customer_id = COALESCE($3, stripe_customer_id),
              stripe_subscription_id = COALESCE($4, stripe_subscription_id)
        WHERE id = $1`,
      [reqId, facilityId, billing.customerId || null, billing.subscriptionId || null]
    );

    await writeLog(client, {
      userId: null, targetTable: 'facilities', targetId: facilityId, operationType: '登録',
      after: { self_signup: true, name: request.facility_name, admin_login_id: email, plan: planCode },
      facilityId,
    });

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* noop */ }
    throw err;
  } finally {
    client.release();
  }

  // メール送信(トランザクション外)。失敗しても作成自体は成功扱い。
  const setUrl = await sendSetupEmail(email, facilityName, token, { req });
  return { facilityId, adminUserId, token, email, planCode, alreadyDone, setUrl };
}

// パスワード設定リンクをメール送信する。戻り: 設定URL。
async function sendSetupEmail(email, facilityName, token, { req = null } = {}) {
  const base = appBaseUrl(req);
  const setUrl = `${base}/set-password.html?token=${token}`;
  try {
    await sendMail({
      to: email,
      subject: '【試薬在庫管理システム】アカウント作成のご案内（パスワード設定）',
      text:
        `試薬在庫管理システムのお申し込みありがとうございます。\n\n` +
        `施設「${facilityName}」のアカウントを作成しました。\n` +
        `下記リンクからパスワードを設定してご利用を開始してください（${TOKEN_TTL_HOURS}時間有効）。\n\n` +
        `ログインID（メール）: ${email}\n` +
        `パスワード設定URL: ${setUrl}\n\n` +
        `※このメールに心当たりがない場合は破棄してください。\n` +
        `※メールが届かない場合は迷惑メールフォルダもご確認ください。\n`,
    });
  } catch (e) {
    console.error('[signup] 設定メール送信失敗:', e.message);
  }
  return setUrl;
}

// パスワード設定リンクを再送する(未完了=must_change_password のアカウントのみ)。
// 何度でも再送でき、その都度新しいトークンを発行する(古いトークンは失効しない
// が、set-password 成功時に同ユーザーの未使用トークンは一括失効する)。
// 戻り: { status: 'sent'|'active'|'notfound', email?, setUrl? }
async function resendSetupLink(email, { req = null } = {}) {
  const u = await pool.query(
    `SELECT u.id, u.must_change_password, f.name AS facility_name
       FROM users u JOIN facilities f ON f.id = u.facility_id
      WHERE u.login_id = $1 AND u.user_type = 'admin'
      ORDER BY u.id LIMIT 1`, [email]
  );
  if (u.rowCount === 0) return { status: 'notfound' };
  if (!u.rows[0].must_change_password) return { status: 'active' };
  const token = await issueSetupToken(pool, u.rows[0].id, 'setup');
  const setUrl = await sendSetupEmail(email, u.rows[0].facility_name, token, { req });
  return { status: 'sent', email, setUrl };
}

// トークン検証。有効なら { userId, email, loginId } を返す。無効は null。
async function verifySetupToken(rawToken) {
  if (!rawToken) return null;
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, u.login_id
       FROM password_setup_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [sha256(rawToken)]
  );
  if (rows.length === 0) return null;
  return { tokenId: rows[0].id, userId: rows[0].user_id, loginId: rows[0].login_id };
}

// トークンでパスワードを設定(消費)。戻り: { loginId }
async function setPasswordByToken(rawToken, newPassword) {
  const info = await verifySetupToken(rawToken);
  if (!info) { const e = new Error('リンクが無効か有効期限切れです。再発行してください。'); e.status = 400; throw e; }
  if (String(newPassword).length < 8) { const e = new Error('パスワードは8文字以上にしてください'); e.status = 400; throw e; }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const hash = bcrypt.hashSync(String(newPassword), 10);
    await client.query(
      `UPDATE users SET password_hash = $1, password_updated_at = now(), must_change_password = FALSE WHERE id = $2`,
      [hash, info.userId]
    );
    await client.query('UPDATE password_setup_tokens SET used_at = now() WHERE id = $1', [info.tokenId]);
    // 同ユーザーの未使用トークンは無効化(使い回し防止)
    await client.query(
      `UPDATE password_setup_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [info.userId]
    );
    await writeLog(client, { userId: info.userId, targetTable: 'users', targetId: info.userId, operationType: '更新', after: { password_set: true } });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* noop */ }
    throw err;
  } finally {
    client.release();
  }
  return { loginId: info.loginId };
}

module.exports = {
  appBaseUrl,
  createFacilityWithAdmin,
  issueSetupToken,
  completeSignup,
  sendSetupEmail,
  resendSetupLink,
  verifySetupToken,
  setPasswordByToken,
};
