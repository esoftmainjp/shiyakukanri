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
// サーバー(設定画面)のテーマを取得して反映
async function syncTheme() {
  try {
    const { ok, data } = await api('/api/settings');
    if (ok && data.settings && data.settings.theme) applyTheme(data.settings.theme);
  } catch (e) { /* ignore */ }
}

// 共通APIヘルパー
async function api(path, options = {}) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, options));
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ログイン確認 → 未ログインなら index へ。ヘッダーにユーザー名とナビを描画。
async function initPage(activeKey) {
  const { ok, data } = await api('/api/me');
  if (!ok) {
    if (location.pathname !== '/' && !location.pathname.endsWith('index.html')) {
      location.href = '/';
    }
    return null;
  }
  renderHeader(data.user, activeKey);
  syncTheme();
  return data.user;
}

function renderHeader(user, activeKey) {
  const header = document.querySelector('header');
  if (!header) return;
  // 権限別のメニュー
  let nav;
  if (user.userType === 'supplier') {
    nav = [
      ['dashboard', '/', 'ホーム'],
      ['receipts', '/receipts.html', '入庫'],
      ['orders', '/orders.html', '発注'],
    ];
  } else {
    nav = [
      ['dashboard', '/', 'ホーム'],
      ['receipts', '/receipts.html', '入庫'],
      ['issues', '/issues.html', '出庫'],
      ['orders', '/orders.html', '発注'],
      ['inventory', '/inventory.html', '在庫管理'],
      ['expiry', '/expiry.html', '使用期限'],
      ['useend', '/use-end.html', '使用終了日'],
      ['labels', '/labels.html', 'バーコード印刷'],
      ['history', '/history.html', '履歴'],
      ['ledger', '/ledger.html', '試薬台帳'],
    ];
    if (user.userType === 'admin') {
      nav.push(['masters', '/masters.html', 'マスター編集']);
      nav.push(['logs', '/logs.html', '操作ログ']);
      nav.push(['settings', '/settings.html', '設定']);
    }
  }
  header.innerHTML =
    '<h1>試薬在庫管理システム</h1>' +
    '<nav>' + nav.map(([k, href, label]) =>
      `<a href="${href}" class="${k === activeKey ? 'active' : ''}">${label}</a>`
    ).join('') + '</nav>' +
    '<span class="spacer"></span>' +
    `<span class="user">${user.name}（${roleLabel(user.userType)}）</span>` +
    '<button class="secondary" onclick="logout()">ログアウト</button>';
}

function roleLabel(t) {
  return { admin: '管理者', general: '一般', supplier: '問屋' }[t] || t;
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
