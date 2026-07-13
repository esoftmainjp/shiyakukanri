'use strict';
// バーコードラベル描画の共通処理。1次元(CODE128, JsBarcode)と2次元(QRコード, qrcode-generator)を
// 端末設定(barcode_kind)で切り替える。2次元は専用の設定(サイズ・文字サイズ)を別に持つ。
//   1D設定: label_width_mm/label_height_mm/barcode_height_px/barcode_width_mm/
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

// 指定した種別('1d'|'2d')の描画設定を返す(端末設定に依存せず取得したいとき用)
function getBarcodeConfigFor(kind) {
  if (kind === '2d') {
    return {
      kind: '2d',
      lw: _bn('label2d_width_mm', 40), lh: _bn('label2d_height_mm', 30),
      qr: _bn('barcode2d_size_mm', 22),
      bcFont: _bn('label2d_barcode_font', 8),
      nameFont: _bn('label2d_name_font', 12),
      subFont: _bn('label2d_sub_font', 11),
    };
  }
  return {
    kind: '1d',
    lw: _bn('label_width_mm', 52), lh: _bn('label_height_mm', 29),
    bh: _bn('barcode_height_px', 60), bwmm: _bn('barcode_width_mm', 45),
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
  return `.label{width:${cfg.lw}mm;height:${cfg.lh}mm;}` +
    `@media print{@page{size:${cfg.lw}mm ${cfg.lh}mm;margin:0;}}`;
}

// .label 要素に、バーコード(1D/2D)＋テキストを描画する
function renderLabelInner(label, b, cfg) {
  label.innerHTML = '';
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
    txt.innerHTML =
      `<div class="sub" style="font-size:${cfg.bcFont}px;">${_bcEsc(b.barcode_value)}</div>` +
      `<div class="pname" style="font-size:${cfg.nameFont}px;">${_bcEsc(b.product_name)}</div>` +
      `<div class="sub" style="font-size:${cfg.subFont}px;">${[lot, exp].filter(Boolean).map(_bcEsc).join('　')}</div>` +
      `<div class="sub" style="font-size:${cfg.subFont}px;">No.${_bcEsc(b.content_code)}</div>`;
    label.appendChild(txt);
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
      height: cfg.bh, margin: 0, width: 2,
    });
    const natW = Number(svg.getAttribute('width'));
    const natH = Number(svg.getAttribute('height'));
    if (natW && natH) {
      svg.setAttribute('viewBox', `0 0 ${natW} ${natH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.width = cfg.bwmm + 'mm';
      svg.style.height = natH + 'px';
    }
  } catch (e) { svg.outerHTML = `<div style="color:red;">描画失敗:${_bcEsc(b.barcode_value)}</div>`; }
}
