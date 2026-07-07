'use strict';

// ===== 画面テーマ(パステル数種類) =====
// ページ読込時に端末キャッシュ(localStorage)で即時適用し、ログイン後にサーバー設定へ同期
function applyTheme(name) {
  const t = name || 'blue';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('appTheme', t); } catch (e) { /* ignore */ }
}
(function () {
  try {
    const t = localStorage.getItem('appTheme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* ignore */ }
})();
// ===== 端末別設定(この端末のブラウザ=localStorageに保存) =====
// テーマ(画面カラー)とバーコードラベルの既定サイズは端末ごとに保持する。
// 全ユーザーが「端末設定」画面から変更できる(施設共通設定とは別)。
const DEVICE_LABEL_DEFAULTS = {
  label_width_mm: 52, label_height_mm: 29, barcode_height_px: 60, barcode_width_mm: 45,
  label_barcode_font: 6, label_name_font: 13, label_sub_font: 13,
};
function getDeviceSetting(key, def) {
  try {
    const v = localStorage.getItem('dev_' + key);
    if (v !== null && v !== '') return v;
  } catch (e) { /* ignore */ }
  return (def !== undefined) ? def : DEVICE_LABEL_DEFAULTS[key];
}
function setDeviceSetting(key, value) {
  try { localStorage.setItem('dev_' + key, String(value)); } catch (e) { /* ignore */ }
}

// ローカル(端末=日本時間)の日付を 'YYYY-MM-DD' で返す。
// new Date().toISOString() はUTCのため、JST早朝(0〜9時)に前日になってしまう。
// 日付入力の既定値や相対日付の算出は必ずこれを使う。
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 共通APIヘルパー
async function api(path, options = {}) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, options));
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// /api/me の直近レスポンス(施設コンテキスト等)を保持
let currentMe = null;

// ログイン確認 → 未ログインなら index へ。ヘッダーにユーザー名とナビを描画。
async function initPage(activeKey) {
  const { ok, data } = await api('/api/me');
  if (!ok) {
    if (location.pathname !== '/' && !location.pathname.endsWith('index.html')) {
      location.href = '/';
    }
    return null;
  }
  currentMe = data;
  // 初回ログイン(パスワード変更要求)時は、変更画面へ誘導する
  if (data.user.mustChangePassword && activeKey !== 'password') {
    location.href = '/password.html';
    return null;
  }
  renderHeader(data.user, activeKey);
  // パスワード有効期限切れ(0=無効)ならメッセージを表示
  if (data.passwordExpired && activeKey !== 'password') showPasswordExpiryBanner();
  // テーマは端末別(localStorage)。ページ読込時のIIFEで適用済み。
  return data.user;
}

// パスワード有効期限切れの案内バー
function showPasswordExpiryBanner() {
  if (document.getElementById('pwExpireBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'pwExpireBanner';
  bar.style.cssText = 'background:#fdecea; color:#b23b3b; border:1px solid #f0b6b6; padding:10px 16px; margin:0 0 12px; border-radius:8px; font-weight:700;';
  bar.innerHTML = 'パスワードの有効期限が過ぎています。<a href="/password.html" style="color:#b23b3b; text-decoration:underline;">パスワードを変更</a>してください。';
  const main = document.querySelector('main');
  if (main) main.insertBefore(bar, main.firstChild);
  else document.body.appendChild(bar);
}

function escHeader(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ナビ要素の生成ヘルパー
function mkLink(k, href, label) { return { type: 'link', k, href, label }; }
function mkGroup(label, items) { return { type: 'group', label, items }; }
function renderNavLink(m, activeKey) {
  const ext = /\.pdf(\?|$)/.test(m.href) ? ' target="_blank" rel="noopener"' : '';
  return `<a href="${m.href}"${ext} class="${m.k === activeKey ? 'active' : ''}">${escHeader(m.label)}</a>`;
}
function renderNavGroup(g, activeKey) {
  const active = g.items.some(([k]) => k === activeKey);
  const links = g.items.map(([k, href, label]) => renderNavLink({ k, href, label }, activeKey)).join('');
  return `<div class="navgroup">` +
    `<button type="button" class="navtrigger${active ? ' active' : ''}" onclick="toggleNav(event)">${escHeader(g.label)} <span class="caret">▾</span></button>` +
    `<div class="navmenu">${links}</div></div>`;
}
// メニュー開閉(クリックで開き、他は閉じる)
function toggleNav(ev) {
  ev.stopPropagation();
  const grp = ev.currentTarget.closest('.navgroup');
  const wasOpen = grp.classList.contains('open');
  document.querySelectorAll('.navgroup.open').forEach((g) => g.classList.remove('open'));
  if (!wasOpen) grp.classList.add('open');
}
document.addEventListener('click', () => {
  document.querySelectorAll('.navgroup.open').forEach((g) => g.classList.remove('open'));
});

// プランで当該機能が使えるか。プラン未設定(superadmin未選択等)は全許可。
function planAllows(featKey) {
  const me = currentMe || {};
  if (!me.plan) return true;
  return me.plan[featKey] !== false;
}

// 施設の運用メニュー(管理者・一般・施設選択中の全体管理者で共通)。プランで機能を出し分け。
function operationalMenu(includeAdmin) {
  const stockItems = [
    ['inventory', '/inventory.html', '在庫管理'],
    planAllows('feat_stocktake') && ['stocktake', '/stocktake.html', '棚卸し'],
    ['expiry', '/expiry.html', '使用期限'],
    ['useend', '/use-end.html', '使用終了日'],
    planAllows('feat_barcode') && ['labels', '/labels.html', 'バーコード印刷'],
  ].filter(Boolean);
  const histItems = [
    ['history', '/history.html', '履歴'],
    planAllows('feat_reports') && ['reports', '/reports.html', '集計'],
    planAllows('feat_ledger') && ['ledger', '/ledger.html', '試薬台帳'],
  ].filter(Boolean);
  const m = [
    mkLink('dashboard', '/', 'ホーム'),
    mkLink('receipts', '/receipts.html', '入庫'),
    mkLink('issues', '/issues.html', '出庫'),
    mkLink('orders', '/orders.html', '発注'),
    mkGroup('在庫', stockItems),
    mkGroup('履歴・集計', histItems),
  ];
  if (includeAdmin) {
    const adminItems = [
      ['masters', '/masters.html', 'マスター編集'],
      planAllows('feat_billing') && ['billing', '/billing.html', '支払管理'],
      ['logs', '/logs.html', '操作ログ'],
      ['settings', '/settings.html', '施設設定'],
    ].filter(Boolean);
    m.push(mkGroup('管理', adminItems));
  }
  return m;
}

function renderHeader(user, activeKey) {
  const header = document.querySelector('header');
  if (!header) return;

  // 権限別のメインメニュー(直リンク or グループ)
  const main = [];
  if (user.userType === 'superadmin') {
    const facSelected = currentMe && currentMe.activeFacilityId != null;
    main.push(mkGroup('システム', [
      ['facilities', '/facilities.html', '施設管理'],
      ['dbusage', '/db-usage.html', 'DB使用量'],
    ]));
    // 施設を選択中は、その施設の管理者と同等のメニューを表示
    if (facSelected) operationalMenu(true).forEach((m) => main.push(m));
  } else if (user.userType === 'supplier') {
    main.push(mkLink('dashboard', '/', 'ホーム'));
    main.push(mkLink('receipts', '/receipts.html', '入庫'));
    main.push(mkLink('orders', '/orders.html', '発注'));
  } else {
    operationalMenu(user.userType === 'admin').forEach((m) => main.push(m));
  }

  // アカウントメニュー(ユーザー名の下に集約)
  const accountItems = [
    ['device', '/device-settings.html', '端末設定'],
    ['password', '/password.html', 'パスワード変更'],
    ['manual', '/manual.pdf', '取扱説明書'],
  ];

  // 施設表示(全体管理者はセレクタ、それ以外は所属施設名)
  const me = currentMe || {};
  let facilityHtml = '';
  if (user.userType === 'superadmin') {
    const opts = ['<option value="">（全施設）</option>'].concat(
      (me.facilities || []).map((f) =>
        `<option value="${f.id}"${String(me.activeFacilityId) === String(f.id) ? ' selected' : ''}>${escHeader(f.name)}</option>`)
    ).join('');
    facilityHtml = `<span class="facility">施設:<select onchange="activateFacility(this.value)" style="margin-left:4px; width:auto;">${opts}</select></span>`;
  } else if (me.facilityName) {
    facilityHtml = `<span class="facility">施設: <strong>${escHeader(me.facilityName)}</strong></span>`;
  }

  const mainHtml = main.map((m) => (m.type === 'group' ? renderNavGroup(m, activeKey) : renderNavLink(m, activeKey))).join('');
  const accLinks = accountItems.map(([k, href, label]) => renderNavLink({ k, href, label }, activeKey)).join('') +
    `<button type="button" class="navitem-btn" onclick="logout()">ログアウト</button>`;
  const accountHtml = `<div class="navgroup accountgroup">` +
    `<button type="button" class="navtrigger usertrigger" onclick="toggleNav(event)">${escHeader(user.name)}（${roleLabel(user.userType)}）<span class="caret">▾</span></button>` +
    `<div class="navmenu navmenu-right">${accLinks}</div></div>`;

  header.innerHTML =
    '<h1>試薬在庫管理システム</h1>' +
    '<nav>' + mainHtml + '</nav>' +
    '<span class="spacer"></span>' +
    facilityHtml +
    accountHtml;
}

// 全体管理者: 操作対象の施設を切り替える
async function activateFacility(id) {
  await api('/api/facilities/activate', { method: 'POST', body: JSON.stringify({ facilityId: id || null }) });
  location.reload();
}

function roleLabel(t) {
  return { superadmin: '全体管理者', admin: '管理者', general: '一般', supplier: '問屋' }[t] || t;
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// 商品一覧をキャッシュ取得
let _productsCache = null;
async function getProducts() {
  if (_productsCache) return _productsCache;
  const { data } = await api('/api/lookup/products');
  _productsCache = data.products || [];
  return _productsCache;
}
