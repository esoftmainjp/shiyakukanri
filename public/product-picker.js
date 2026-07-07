'use strict';

// 商品検索モーダル(複数画面で再利用)。
//   ProductPicker.open({ inStockOnly, defaultSupplierId, onSelect })
//   onSelect(product) … product = { productId, productName, supplierIds:[], pickedSupplierId }
// api() (common.js) と esc は本ファイル内で用意。

var ProductPicker = (function () {
  var cache = {};
  var onSelectCb = null;
  var currentOpts = {};
  var results = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  async function lookup(kind) {
    if (cache[kind]) return cache[kind];
    var r = await api('/api/lookup/' + kind);
    cache[kind] = (r.data && r.data[kind]) || [];
    return cache[kind];
  }

  function injectOnce() {
    if ($('pp-modal')) return;
    var style = document.createElement('style');
    style.textContent =
      '.pp-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;z-index:50;}' +
      '.pp-bg.show{display:flex;}' +
      '.pp-card{background:#fff;border-radius:10px;padding:18px;min-width:min(900px,95vw);max-width:95vw;max-height:92vh;overflow:auto;}' +
      '.pp-card h3{margin:0;font-size:1rem;}' +
      '#pp-tbl{width:100%;border-collapse:collapse;margin-top:6px;}' +
      '#pp-tbl th,#pp-tbl td{border:1px solid var(--line,#e3e8ef);padding:4px 8px;text-align:left;font-size:.85rem;}' +
      '#pp-tbl th{background:#eef2f5;position:sticky;top:0;}' +
      '#pp-tbl tbody tr:hover{background:#f3f8ff;}' +
      '.pp-num{text-align:right;font-variant-numeric:tabular-nums;}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'pp-bg';
    wrap.id = 'pp-modal';
    wrap.innerHTML =
      '<div class="pp-card">' +
      '  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
      '    <h3>商品を検索して選択</h3>' +
      '    <button type="button" class="secondary" onclick="ProductPicker.close()">閉じる</button>' +
      '  </div>' +
      '  <div class="row" style="margin-top:10px;">' +
      '    <div><label>問屋</label><select id="pp-supplier"><option value="">すべて</option></select></div>' +
      '    <div><label>メーカー</label><select id="pp-maker"><option value="">すべて</option></select></div>' +
      '    <div><label>部門</label><select id="pp-dept"><option value="">すべて</option></select></div>' +
      '    <div><label>分類</label><select id="pp-cat"><option value="">すべて</option></select></div>' +
      '  </div>' +
      '  <div class="row">' +
      '    <div style="flex:2;"><label>商品名</label><input id="pp-name" placeholder="部分一致" /></div>' +
      '    <div style="flex:0;"><label>&nbsp;</label><button type="button" onclick="ProductPicker.search()">検索</button></div>' +
      '  </div>' +
      '  <p class="msg" id="pp-msg"></p>' +
      '  <div style="max-height:52vh;overflow:auto;">' +
      '    <table id="pp-tbl"><thead><tr><th>商品名</th><th>問屋</th><th>メーカー</th><th>部門</th><th>分類</th><th class="pp-num">在庫(バラ)</th><th></th></tr></thead><tbody></tbody></table>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);

    // 背景クリックで閉じる
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    // 商品名 Enter で検索
    $('pp-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  }

  async function fillFilters() {
    var opt = function (arr) {
      return '<option value="">すべて</option>' + (arr || []).map(function (x) {
        return '<option value="' + x.id + '">' + esc(x.name) + '</option>';
      }).join('');
    };
    var res = await Promise.all([lookup('suppliers'), lookup('makers'), lookup('departments'), lookup('categories')]);
    $('pp-supplier').innerHTML = opt(res[0]);
    $('pp-maker').innerHTML = opt(res[1]);
    $('pp-dept').innerHTML = opt(res[2]);
    $('pp-cat').innerHTML = opt(res[3]);
  }

  async function open(opts) {
    currentOpts = opts || {};
    onSelectCb = currentOpts.onSelect || null;
    injectOnce();
    await fillFilters();
    $('pp-supplier').value = currentOpts.defaultSupplierId ? String(currentOpts.defaultSupplierId) : '';
    $('pp-maker').value = ''; $('pp-dept').value = ''; $('pp-cat').value = '';
    $('pp-name').value = '';
    $('pp-modal').classList.add('show');
    setTimeout(function () { $('pp-name').focus(); }, 30);
    search();
  }

  function close() { var m = $('pp-modal'); if (m) m.classList.remove('show'); }

  async function search() {
    var p = new URLSearchParams();
    var set = function (k, id) { var v = $(id).value; if (v) p.set(k, v); };
    set('supplierId', 'pp-supplier'); set('makerId', 'pp-maker');
    set('departmentId', 'pp-dept'); set('categoryId', 'pp-cat'); set('name', 'pp-name');
    if (currentOpts.inStockOnly) p.set('inStockOnly', 'true');
    var msg = $('pp-msg');
    setMsg(msg, '検索中...', '');
    var r = await api('/api/lookup/product-search?' + p.toString());
    if (!r.ok) { setMsg(msg, (r.data && r.data.error) || '検索に失敗しました', 'error'); return; }
    results = (r.data && r.data.products) || [];
    var tb = document.querySelector('#pp-tbl tbody');
    if (results.length === 0) { tb.innerHTML = '<tr><td colspan="7">該当する商品がありません</td></tr>'; setMsg(msg, '', ''); return; }
    tb.innerHTML = results.map(function (x, i) {
      return '<tr>' +
        '<td>' + esc(x.product_name) + '</td>' +
        '<td>' + esc(x.supplier_names || '') + '</td>' +
        '<td>' + esc(x.maker_names || '') + '</td>' +
        '<td>' + esc(x.department || '') + '</td>' +
        '<td>' + esc(x.category || '') + '</td>' +
        '<td class="pp-num">' + (x.stock_total != null ? x.stock_total : '') + '</td>' +
        '<td><button type="button" class="secondary" onclick="ProductPicker.pick(' + i + ')">選択</button></td>' +
        '</tr>';
    }).join('');
    setMsg(msg, results.length + ' 件', '');
  }

  function pick(i) {
    var x = results[i];
    if (!x) return;
    var pickedSupplierId = $('pp-supplier').value || null;
    close();
    if (onSelectCb) {
      onSelectCb({
        productId: x.product_id,
        productName: x.product_name,
        supplierIds: (x.supplier_ids || []).map(String),
        pickedSupplierId: pickedSupplierId,
      });
    }
  }

  return { open: open, close: close, search: search, pick: pick };
})();

function openProductPicker(opts) { return ProductPicker.open(opts); }
