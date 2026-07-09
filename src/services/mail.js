'use strict';

// メール送信。プロバイダは環境変数で選択(既定は自動判定)。
//   MAIL_PROVIDER = lolipop | resend | none
//     lolipop … ロリポップ設置の自作PHP(send.php)へHTTPS POST(RenderはSMTP遮断のためHTTP経由)
//     resend  … Resend HTTPS API
//   未指定時: LOLIPOP_MAIL_ENDPOINT があれば lolipop、なければ RESEND_API_KEY があれば resend、無ければ none。
// いずれも未構成なら送信せず { sent:false } を返す(ローカル検証や設定前でも動作を止めない)。

function activeProvider() {
  const p = (process.env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (p) return p;
  if (process.env.LOLIPOP_MAIL_ENDPOINT) return 'lolipop';
  if (process.env.RESEND_API_KEY) return 'resend';
  return 'none';
}

// 差出人の表示名(共有send.phpで fromName として渡す。システムごとに自分の名前を指定)
function fromName() { return process.env.MAIL_FROM_NAME || '試薬在庫管理システム'; }

// ロリポップ自作PHPエンドポイント経由(複数システム共有。fromNameで表示名を上書き)
async function sendViaLolipop({ to, subject, text, replyTo }) {
  const endpoint = process.env.LOLIPOP_MAIL_ENDPOINT;
  const token = process.env.LOLIPOP_MAIL_TOKEN;
  if (!endpoint || !token) {
    console.warn('[mail] LOLIPOP_MAIL_ENDPOINT/TOKEN 未設定のため送信をスキップ:', subject, '→', to);
    return { sent: false };
  }
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body: JSON.stringify({ to, subject, text, replyTo, fromName: fromName() }),
  });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    const e = new Error(`Lolipop mail ${r.status}: ${b}`); e.status = r.status; throw e;
  }
  return { sent: true, data: await r.json().catch(() => ({})) };
}

// Resend HTTPS API 経由
async function sendViaResend({ to, subject, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  const fromEmail = process.env.MAIL_FROM || 'onboarding@resend.dev';
  const from = `${fromName()} <${fromEmail}>`;
  if (!key) {
    console.warn('[mail] RESEND_API_KEY 未設定のため送信をスキップ:', subject, '→', to);
    return { sent: false };
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, reply_to: replyTo, subject, text }),
  });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    const e = new Error(`Resend ${r.status}: ${b}`); e.status = r.status; throw e;
  }
  return { sent: true, data: await r.json().catch(() => ({})) };
}

async function sendMail({ to, subject, text, replyTo }) {
  const provider = activeProvider();
  if (provider === 'lolipop') return sendViaLolipop({ to, subject, text, replyTo });
  if (provider === 'resend') return sendViaResend({ to, subject, text, replyTo });
  console.warn('[mail] 送信プロバイダ未設定のためスキップ:', subject, '→', to);
  return { sent: false };
}

module.exports = { sendMail, activeProvider };
