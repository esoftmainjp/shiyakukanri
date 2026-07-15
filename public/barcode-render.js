'use strict';
// バーコードラベル描画の共通処理。1次元(CODE128, JsBarcode)と2次元(QRコード, qrcode-generator)を
// 端末設定(barcode_kind)で切り替える。2次元は専用の設定(サイズ・文字サイズ)を別に持つ。
//   1D設定: label_width_mm/label_height_mm/barcode_height_mm/barcode_width_mm/
//           label_barcode_font/label_name_font/label_sub_font
//   2D設定: label2d_width_mm/label2d_height_mm/barcode2d_size_mm/
//           label2d_barcode_font/label2d_name_font/label2d_sub_font
// getDeviceSetting/setDeviceSetting は common.js を前提とする。

function barcodeKind() {
  return getDeviceSetting('barcode_kind', '1d') === '2d' ? '2d' : '1d';
}

function _bn(key, def) {
  const v = getDeviceSetting(key, def);
  const n = Number(v);
  return isNaN(n) ? def : n;
}

// レイアウト別(縦/横)の2D設定を取得。キーは base+('_v'|'_h')。
// 縦は旧キー(接尾辞なし)を後方互換で参照する。
function _bn2(base, layout, def) {
  const k = base + (layout === 'horizontal' ? '_h' : '_v');
  let v = getDeviceSetting(k, null);
  if ((v === null || v === '') && layout === 'vertical') v = getDeviceSetting(base, null);
  const n = Number(v);
  return (v === null || v === '' || isNaN(n)) ? def : n;
}

// 指定した種別('1d'|'2d')の描画設定を返す(端末設定に依存せず取得したいとき用)
function getBarcodeConfigFor(kind) {
  if (kind === '2d') {
    // 縦並び/横並びで別々に設定を保持する。横並びは幅を広めに既定。
    const layout = (getDeviceSetting('label2d_layout', 'vertical') === 'horizontal') ? 'horizontal' : 'vertical';
    const defW = layout === 'horizontal' ? 60 : 40;
    return {
      kind: '2d', layout,
      lw: _bn2('label2d_width_mm', layout, defW), lh: _bn2('label2d_height_mm', layout, 30),
      qr: _bn2('barcode2d_size_mm', layout, 22),
      bcFont: _bn2('label2d_barcode_font', layout, 8),
      nameFont: _bn2('label2d_name_font', layout, 12),
      subFont: _bn2('label2d_sub_font', layout, 11),
    };
  }
  return {
    kind: '1d',
    lw: _bn('label_width_mm', 52), lh: _bn('label_height_mm', 29),
    bhmm: _bn('barcode_height_mm', 15), bwmm: _bn('barcode_width_mm', 45),
    bcFont: _bn('label_barcode_font', 6),
    nameFont: _bn('label_name_font', 13),
    subFont: _bn('label_sub_font', 13),
  };
}

// 現在の端末設定に従った描画設定
function getBarcodeConfig() { return getBarcodeConfigFor(barcodeKind()); }

// 種別に応じた描画ライブラリが読み込めているか
function barcodeLibReady(kind) {
  return kind === '2d' ? (typeof qrcode !== 'undefined') : (typeof JsBarcode !== 'undefined');
}

function _bcEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ラベルのページ/プレビューサイズCSS
function labelPageStyleText(cfg) {
  let css = `.label{width:${cfg.lw}mm;height:${cfg.lh}mm;}` +
    `@media print{@page{size:${cfg.lw}mm ${cfg.lh}mm;margin:0;}}`;
  // 末尾の空白ラベル対策(端末設定でONのときのみ)。
  // 改ページを各ラベルの「後」ではなく「前(先頭を除く)」に入れ、末尾に改ページを残さない。
  // barcode-print(.labelが直下)・labels(.label-wrapが直下)の両構造に効くよう .labels>* を対象にする。
  if (getDeviceSetting('label_trim_blank', 'false') === 'true') {
    css += `@media print{` +
      `.label{page-break-after:auto !important;break-after:auto !important;}` +
      `.labels>*{page-break-before:always !important;break-before:page !important;}` +
      `.labels>*:first-child{page-break-before:avoid !important;break-before:avoid !important;}` +
      `}`;
  }
  return css;
}

// .label 要素に、バーコード(1D/2D)＋テキストを描画する
function renderLabelInner(label, b, cfg) {
  label.innerHTML = '';
  // 再描画(種別/並び切替)での残留を防ぐため、並び関連のインラインスタイルを初期化
  label.style.flexDirection = '';
  label.style.gap = '';
  const exp = b.expiry_date ? `期限:${b.expiry_date}` : '';
  const lot = b.lot_number ? `Lot:${b.lot_number}` : '';

  if (cfg.kind === '2d') {
    // QRコード
    try {
      const qr = qrcode(0, 'M');           // 型番自動・誤り訂正M
      qr.addData(String(b.barcode_value));
      qr.make();
      const holder = document.createElement('div');
      let svgStr;
      try { svgStr = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true }); }
      catch (e) { svgStr = qr.createSvgTag(2, 0); }
      holder.innerHTML = svgStr;
      const svg = holder.querySelector('svg');
      if (svg) {
        if (!svg.getAttribute('viewBox')) {
          const w = Number(svg.getAttribute('width')) || 0, h = Number(svg.getAttribute('height')) || 0;
          if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        }
        svg.removeAttribute('width'); svg.removeAttribute('height');
        svg.style.width = cfg.qr + 'mm'; svg.style.height = cfg.qr + 'mm'; svg.style.display = 'block';
        label.appendChild(svg);
      }
    } catch (e) {
      const d = document.createElement('div'); d.style.color = 'red'; d.textContent = 'QR描画失敗:' + b.barcode_value;
      label.appendChild(d);
    }
    const txt = document.createElement('div');
    txt.className = 'txt';
    // ロットと有効期限は別行に表示(有効期限を改行)
    txt.innerHTML =
      `<div class="sub" style="font-size:${cfg.bcFont}px;">${_bcEsc(b.barcode_value)}</div>` +
      `<div class="pname" style="font-size:${cfg.nameFont}px;">${_bcEsc(b.product_name)}</div>` +
      (lot ? `<div class="sub" style="font-size:${cfg.subFont}px;">${_bcEsc(lot)}</div>` : '') +
      (exp ? `<div class="sub" style="font-size:${cfg.subFont}px;">${_bcEsc(exp)}</div>` : '') +
      `<div class="sub" style="font-size:${cfg.subFont}px;">No.${_bcEsc(b.content_code)}</div>`;
    label.appendChild(txt);
    // 横並び: QRの右に情報を配置(縦並びはページCSSの縦積み・中央寄せに従う)
    if (cfg.layout === 'horizontal') {
      label.style.flexDirection = 'row';
      label.style.gap = '1.5mm';
      txt.style.width = 'auto';
      txt.style.textAlign = 'left';
      txt.style.marginTop = '0';
    }
    return;
  }

  // 1次元(CODE128)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  label.appendChild(svg);
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.innerHTML =
    `<div class="pname" style="font-size:${cfg.nameFont}px;">${_bcEsc(b.product_name)}</div>` +
    `<div class="sub" style="font-size:${cfg.subFont}px;">${[lot, exp].filter(Boolean).map(_bcEsc).join('　')}</div>` +
    `<div class="sub" style="font-size:${cfg.subFont}px;">No.${_bcEsc(b.content_code)}</div>`;
  label.appendChild(txt);
  try {
    JsBarcode(svg, b.barcode_value, {
      format: 'CODE128', displayValue: true, fontSize: cfg.bcFont || 6, textMargin: 0,
      // バーコード高はmm指定。生成用に mm→px に換算(1mm≒3.78px)。最終高さは下でmm指定する。
      height: Math.max(1, Math.round(cfg.bhmm * 96 / 25.4)), margin: 0, width: 2,
    });
    // JsBarcodeは width/height を "246px" のように単位付きで出力するため、
    // Number() ではなく parseFloat() で数値化する(Number("246px")はNaNになり幅指定が無効化される)
    const natW = parseFloat(svg.getAttribute('width'));
    const natH = parseFloat(svg.getAttribute('height'));
    if (natW && natH) {
      svg.setAttribute('viewBox', `0 0 ${natW} ${natH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.width = cfg.bwmm + 'mm';
      svg.style.height = cfg.bhmm + 'mm';
    }
  } catch (e) { svg.outerHTML = `<div style="color:red;">描画失敗:${_bcEsc(b.barcode_value)}</div>`; }
}
