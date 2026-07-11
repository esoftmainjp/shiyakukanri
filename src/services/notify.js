'use strict';

// 能動通知: 期限接近・期限切れ、在庫僅少(発注点割れ)を集計し、施設の管理者へメール送信する。
//   ・日次ジョブ(server.js)から runDaily() を呼ぶ。1施設1日1通(notification_state で重複抑止)。
//   ・設定画面から「今すぐ送信」する場合は runForFacility(..., { force:true, ignoreEnabled:true })。
// 設定(app_settings 施設別。未設定は既定):
//   notify_expiry_enabled   期限通知の有効(既定 '1')
//   notify_low_stock_enabled 在庫僅少通知の有効(既定 '1')
//   notify_email            宛先(カンマ/セミコロン区切り。未設定は施設管理者のログインID=メール)
//   expiry_warn_days        期限接近の既定日数(既定 30。商品詳細の警告日数が優先)
//   low_stock_threshold     在庫僅少の予備しきい値(発注点=最低個数が0のとき使用。既定 0)

const { sendMail, activeProvider } = require('./mail');

// 設定画面はチェックボックスを 'true'/'false' で保存する。未設定の既定は '1'。
// いずれの表現でも有効と判定できるようにする。
function flagOn(v) {
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

async function getSetting(db, key, defaultValue, facilityId) {
  const { rows } = await db.query(
    `SELECT value FROM app_settings
      WHERE key = $1 AND (facility_id = $2 OR facility_id IS NULL)
      ORDER BY facility_id NULLS LAST
      LIMIT 1`,
    [key, facilityId]
  );
  return rows.length ? rows[0].value : defaultValue;
}

// 施設の宛先メール。notify_email 設定があればそれを、無ければ管理者のログインID(=メール)。
async function resolveRecipients(db, facilityId, notifyEmail) {
  const explicit = String(notifyEmail || '')
    .split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  if (explicit.length) return explicit;
  const { rows } = await db.query(
    `SELECT login_id FROM users
      WHERE facility_id = $1 AND user_type = 'admin' AND is_active = TRUE
      ORDER BY id`,
    [facilityId]
  );
  return rows.map((r) => r.login_id).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

// 期限接近・期限切れの在庫(施設別)。警告日数は商品詳細を優先し、無ければ既定 warnDays。
async function queryExpiry(db, facilityId, warnDays) {
  const { rows } = await db.query(
    `WITH base AS (
       SELECT p.name AS product_name, sh.name AS shelf,
              s.lot_number, s.expiry_date, s.stock_quantity,
              (s.expiry_date - CURRENT_DATE) AS days_left,
              COALESCE(NULLIF((
                 SELECT pd.expiry_warn_days FROM product_details pd
                  WHERE pd.product_id = p.id
                  ORDER BY (pd.apply_start_date <= CURRENT_DATE
                            AND (pd.apply_end_date IS NULL OR pd.apply_end_date >= CURRENT_DATE)) DESC,
                           pd.apply_start_date DESC
                  LIMIT 1), 0), $2) AS warn_days
         FROM product_stocks s
         JOIN products p ON p.id = s.product_id
         LEFT JOIN shelves sh ON sh.id = p.shelf_id
        WHERE s.stock_quantity > 0 AND s.expiry_date IS NOT NULL AND p.facility_id = $1
     )
     SELECT *, CASE WHEN expiry_date < CURRENT_DATE THEN 'expired' ELSE 'warning' END AS status
       FROM base
      WHERE expiry_date <= CURRENT_DATE + (warn_days || ' days')::interval
      ORDER BY expiry_date`,
    [facilityId, warnDays]
  );
  return rows;
}

// 在庫僅少(発注点割れ)の商品(施設別)。しきい値 = 最低個数(現行商品詳細)。0なら予備しきい値 low_stock_threshold。
async function queryLowStock(db, facilityId, fallbackThreshold) {
  const { rows } = await db.query(
    `WITH cur_pd AS (
       SELECT DISTINCT ON (pd.product_id) pd.product_id, pd.min_quantity, pd.order_quantity, pd.supplier_id
         FROM product_details pd
        WHERE pd.facility_id = $1
        ORDER BY pd.product_id,
                 (pd.apply_start_date <= CURRENT_DATE
                  AND (pd.apply_end_date IS NULL OR pd.apply_end_date >= CURRENT_DATE)) DESC,
                 pd.apply_start_date DESC
     ),
     tot AS (
       SELECT ps.product_id, COALESCE(SUM(ps.stock_quantity), 0) AS total
         FROM product_stocks ps
         JOIN products p ON p.id = ps.product_id
        WHERE p.facility_id = $1
        GROUP BY ps.product_id
     )
     SELECT p.name AS product_name, sh.name AS shelf,
            COALESCE(t.total, 0) AS total,
            GREATEST(COALESCE(NULLIF(cp.min_quantity, 0), $2), 0) AS threshold,
            COALESCE(cp.order_quantity, 0) AS order_quantity,
            s.name AS supplier
       FROM products p
       LEFT JOIN tot t ON t.product_id = p.id
       LEFT JOIN cur_pd cp ON cp.product_id = p.id
       LEFT JOIN suppliers s ON s.id = cp.supplier_id
       LEFT JOIN shelves sh ON sh.id = p.shelf_id
      WHERE p.facility_id = $1 AND p.is_active = TRUE
        AND GREATEST(COALESCE(NULLIF(cp.min_quantity, 0), $2), 0) > 0
        AND COALESCE(t.total, 0) < GREATEST(COALESCE(NULLIF(cp.min_quantity, 0), $2), 0)
      ORDER BY p.name`,
    [facilityId, fallbackThreshold]
  );
  return rows;
}

function fmtDate(d) {
  if (!d) return '';
  const s = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return s;
}

// メール本文(プレーンテキスト)を組み立てる。
function buildEmail(facilityName, baseUrl, expiry, lowStock) {
  const lines = [];
  lines.push(`${facilityName} の在庫状況をお知らせします。`);
  lines.push('');
  if (expiry) {
    const expired = expiry.filter((r) => r.status === 'expired');
    const soon = expiry.filter((r) => r.status !== 'expired');
    lines.push(`■ 使用期限（期限切れ ${expired.length}件 / 期限接近 ${soon.length}件）`);
    if (expiry.length === 0) {
      lines.push('　該当なし');
    } else {
      expiry.forEach((r) => {
        const loc = r.shelf ? `［${r.shelf}］` : '';
        const lot = r.lot_number ? ` ロット:${r.lot_number}` : '';
        const days = Number(r.days_left);
        const state = r.status === 'expired' ? `期限切れ(${-days}日超過)` : `残${days}日`;
        lines.push(`　・${r.product_name}${loc}${lot}　期限:${fmtDate(r.expiry_date)}　${state}　在庫:${r.stock_quantity}`);
      });
    }
    lines.push('');
  }
  if (lowStock) {
    lines.push(`■ 在庫僅少（発注点割れ ${lowStock.length}件）`);
    if (lowStock.length === 0) {
      lines.push('　該当なし');
    } else {
      lowStock.forEach((r) => {
        const loc = r.shelf ? `［${r.shelf}］` : '';
        const sup = r.supplier ? `　問屋:${r.supplier}` : '';
        lines.push(`　・${r.product_name}${loc}　在庫:${r.total} < 発注点:${r.threshold}${sup}`);
      });
    }
    lines.push('');
  }
  if (baseUrl) {
    lines.push(`詳細・対応はこちら: ${baseUrl}`);
    lines.push('');
  }
  lines.push('※ この通知は自動送信です。宛先や通知の有無は「設定」画面で変更できます。');
  return lines.join('\n');
}

// 1施設分の通知処理。sent/skip理由と件数を返す。
//   force        … 当日送信済みでも送る(重複抑止を無視)
//   ignoreEnabled … 有効化フラグを無視して集計・送信(テスト送信用)
async function runForFacility(db, facilityId, opts = {}) {
  const { force = false, ignoreEnabled = false } = opts;
  const fRow = await db.query('SELECT id, name, is_active FROM facilities WHERE id = $1', [facilityId]);
  if (fRow.rowCount === 0) return { sent: false, reason: 'facility_not_found' };
  const facility = fRow.rows[0];

  // 既定はOFF(オプトイン)。施設ごとに設定画面で有効化する。
  const expiryEnabled = ignoreEnabled || flagOn(await getSetting(db, 'notify_expiry_enabled', '0', facilityId));
  const lowEnabled = ignoreEnabled || flagOn(await getSetting(db, 'notify_low_stock_enabled', '0', facilityId));
  if (!expiryEnabled && !lowEnabled) return { sent: false, reason: 'disabled' };

  // 重複抑止(当日既送信ならスキップ。force時は無視)
  if (!force) {
    const st = await db.query('SELECT last_sent_date FROM notification_state WHERE facility_id = $1', [facilityId]);
    if (st.rowCount && st.rows[0].last_sent_date && fmtDate(st.rows[0].last_sent_date) === fmtDate(new Date())) {
      return { sent: false, reason: 'already_sent_today' };
    }
  }

  let warnDays = parseInt(await getSetting(db, 'expiry_warn_days', '30', facilityId), 10);
  if (Number.isNaN(warnDays) || warnDays < 0) warnDays = 30;
  let lowThreshold = parseInt(await getSetting(db, 'low_stock_threshold', '0', facilityId), 10);
  if (Number.isNaN(lowThreshold) || lowThreshold < 0) lowThreshold = 0;

  const expiry = expiryEnabled ? await queryExpiry(db, facilityId, warnDays) : null;
  const lowStock = lowEnabled ? await queryLowStock(db, facilityId, lowThreshold) : null;

  const expiryCount = expiry ? expiry.length : 0;
  const lowCount = lowStock ? lowStock.length : 0;
  const counts = { expiry: expiryCount, lowStock: lowCount };

  // 送るものが無ければ送信しない(空メールを避ける)。
  if (expiryCount === 0 && lowCount === 0) return { sent: false, reason: 'no_items', counts };

  if (activeProvider() === 'none') return { sent: false, reason: 'mail_not_configured', counts };

  const notifyEmail = await getSetting(db, 'notify_email', '', facilityId);
  const recipients = await resolveRecipients(db, facilityId, notifyEmail);
  if (recipients.length === 0) return { sent: false, reason: 'no_recipient', counts };

  const baseUrl = process.env.APP_BASE_URL || '';
  const text = buildEmail(facility.name, baseUrl, expiry, lowStock);
  const parts = [];
  if (expiryEnabled) parts.push(`期限${expiryCount}件`);
  if (lowEnabled) parts.push(`在庫僅少${lowCount}件`);
  const subject = `【試薬在庫】要確認: ${parts.join('・')}（${facility.name}）`;

  let sentAny = false;
  const failed = [];
  for (const to of recipients) {
    try {
      const r = await sendMail({ to, subject, text });
      if (r && r.sent) sentAny = true; else failed.push(to);
    } catch (e) {
      failed.push(to);
      console.error('[notify] 送信失敗:', to, e.message);
    }
  }

  if (sentAny) {
    await db.query(
      `INSERT INTO notification_state (facility_id, last_sent_date, updated_at)
         VALUES ($1, CURRENT_DATE, now())
       ON CONFLICT (facility_id) DO UPDATE SET last_sent_date = CURRENT_DATE, updated_at = now()`,
      [facilityId]
    );
    return { sent: true, counts, recipients, failed };
  }
  return { sent: false, reason: 'send_failed', counts, recipients, failed };
}

// 全アクティブ施設に対して日次通知を実行。
async function runDaily(db) {
  try {
    if (activeProvider() === 'none') {
      console.warn('[notify] メール未構成のため日次通知をスキップ');
      return;
    }
    const { rows } = await db.query('SELECT id FROM facilities WHERE is_active = TRUE ORDER BY id');
    let sent = 0;
    for (const f of rows) {
      try {
        const r = await runForFacility(db, f.id, {});
        if (r.sent) sent++;
      } catch (e) {
        console.error('[notify] 施設通知エラー facility=%s:', f.id, e.message);
      }
    }
    if (sent) console.log(`[notify] 能動通知メールを送信: ${sent}施設`);
  } catch (err) {
    console.error('[notify] 日次通知処理に失敗:', err.message);
  }
}

module.exports = { runDaily, runForFacility, queryExpiry, queryLowStock, buildEmail };
