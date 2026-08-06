'use strict';

// カメラでバーコードを読み取る共通モジュール(端末設定でON時のみ利用)。
// Android Chrome/Edge等は端末標準の BarcodeDetector、iOS Safari等は同梱ZXingで
// フォールバックする。入庫/出庫/棚卸の各画面から CameraScan.open() で呼び出す。
// window.CameraScan = { enabled(), open({title,onResult}) }
(function () {
  // 端末設定(localStorage: dev_camera_scan='1')でONか
  function enabled() {
    try { return localStorage.getItem('dev_camera_scan') === '1'; } catch (e) { return false; }
  }

  // 同梱ZXingを必要時のみ遅延ロード(約0.7MBを常時読み込まないため)
  let zxingLoading = null;
  function loadZxing() {
    if (typeof ZXingBrowser !== 'undefined') return Promise.resolve();
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise((resolve, reject) => {
      const s1 = document.createElement('script');
      s1.src = '/vendor/zxing-library.min.js';
      s1.onload = () => {
        const s2 = document.createElement('script');
        s2.src = '/vendor/zxing-browser.min.js';
        s2.onload = () => resolve();
        s2.onerror = () => reject(new Error('ZXing(browser)の読込に失敗しました'));
        document.head.appendChild(s2);
      };
      s1.onerror = () => reject(new Error('ZXing(library)の読込に失敗しました'));
      document.head.appendChild(s1);
    });
    return zxingLoading;
  }

  // 読み取りたい形式(GS1-128=CODE128 / JAN=EAN / QR / DataMatrix 等)
  const WANT = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'itf', 'data_matrix'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function open(opts) {
    opts = opts || {};
    const onResult = typeof opts.onResult === 'function' ? opts.onResult : function () {};
    const title = opts.title || 'カメラでスキャン';

    // ==== オーバーレイUI ====
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed; inset:0; z-index:9999; background:rgba(8,14,20,.92); display:flex; flex-direction:column; align-items:center; justify-content:flex-start; padding:12px; box-sizing:border-box;';
    ov.innerHTML =
      '<div style="width:100%; max-width:720px; color:#e6eef6;">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">' +
          '<strong style="font-size:1rem;">' + esc(title) + '</strong>' +
          '<button type="button" id="csClose" style="font-size:15px; font-weight:700; padding:8px 14px; border:none; border-radius:8px; background:#c25a6a; color:#fff; cursor:pointer;">閉じる</button>' +
        '</div>' +
        '<div style="position:relative;">' +
          '<video id="csVideo" playsinline muted style="width:100%; max-height:64vh; background:#000; border-radius:12px; object-fit:cover;"></video>' +
          '<div style="position:absolute; inset:14% 8%; border:3px solid rgba(80,190,240,.9); border-radius:12px; pointer-events:none;"></div>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:10px; margin-top:8px; flex-wrap:wrap;">' +
          '<button type="button" id="csTorch" style="display:none; font-size:14px; font-weight:700; padding:8px 12px; border:none; border-radius:8px; background:#22384a; color:#cfe3f2; cursor:pointer;">ライト</button>' +
          '<span id="csEngine" style="font-size:12px; color:#8fb0c8;"></span>' +
          '<span id="csHit" style="font-size:13px; font-weight:700; color:#7fe0a0;"></span>' +
        '</div>' +
        '<p id="csMsg" style="font-size:13px; color:#cfe0ee; margin:8px 2px 0;">バーコードを枠内に写してください。読み取ると自動で明細に反映されます（連続可）。</p>' +
      '</div>';
    document.body.appendChild(ov);

    const video = ov.querySelector('#csVideo');
    const engineEl = ov.querySelector('#csEngine');
    const hitEl = ov.querySelector('#csHit');
    const msgEl = ov.querySelector('#csMsg');
    const torchBtn = ov.querySelector('#csTorch');

    let stream = null, track = null, detector = null, rafTimer = null, zxingControls = null, closed = false;
    let lastCode = '', lastTime = 0, torchOn = false;

    function flashHit(code) {
      const now = Date.now();
      // 直近2秒の同一コードは重複とみなし無視(連続読取の誤多重を防ぐ)
      if (code === lastCode && (now - lastTime) < 2000) return;
      lastCode = code; lastTime = now;
      hitEl.textContent = '読取: ' + code;
      try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
      onResult(code);
    }

    function stop() {
      closed = true;
      if (rafTimer) { clearTimeout(rafTimer); rafTimer = null; }
      try { if (zxingControls) zxingControls.stop(); } catch (e) {}
      zxingControls = null;
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      stream = null; track = null;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    ov.querySelector('#csClose').onclick = stop;

    function setupTorch() {
      try {
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps && caps.torch) {
          torchBtn.style.display = '';
          torchBtn.onclick = async () => {
            torchOn = !torchOn;
            try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) {}
          };
        }
      } catch (e) {}
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      msgEl.textContent = 'このブラウザ/端末はカメラ取得に対応していません。'; msgEl.style.color = '#ffb4b4';
      return;
    }

    const useBD = ('BarcodeDetector' in window);
    try {
      if (useBD) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream; await video.play();
        track = stream.getVideoTracks()[0];
        setupTorch();
        const supported = await BarcodeDetector.getSupportedFormats();
        const formats = WANT.filter((f) => supported.includes(f));
        detector = new BarcodeDetector({ formats: formats.length ? formats : undefined });
        engineEl.textContent = 'エンジン: 端末標準(BarcodeDetector)';
        const tick = async () => {
          if (closed) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) { for (const c of codes) if (c.rawValue) flashHit(String(c.rawValue).trim()); }
          } catch (e) { /* フレーム未準備等は無視 */ }
          rafTimer = setTimeout(tick, 250);
        };
        tick();
      } else {
        // iOS Safari 等: ZXingフォールバック
        engineEl.textContent = 'エンジン: ZXing（読込中…）';
        await loadZxing();
        if (closed) return;
        engineEl.textContent = 'エンジン: ZXing（フォールバック）';
        const hints = new Map();
        const F = ZXing.BarcodeFormat;
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.QR_CODE, F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.DATA_MATRIX, F.CODE_39, F.ITF]);
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        const reader = new ZXingBrowser.BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
        reader.decodeFromVideoDevice(undefined, video, (result, err, controls) => {
          if (closed) { try { controls.stop(); } catch (e) {} return; }
          if (result) flashHit(String(result.getText()).trim());
        }).then((controls) => {
          zxingControls = controls;
          try { track = video.srcObject && video.srcObject.getVideoTracks()[0]; setupTorch(); } catch (e) {}
        }).catch((e) => { msgEl.textContent = '起動に失敗しました: ' + e.message; msgEl.style.color = '#ffb4b4'; });
      }
    } catch (e) {
      msgEl.textContent = 'カメラの起動に失敗しました（権限・対応状況をご確認ください）: ' + e.message;
      msgEl.style.color = '#ffb4b4';
    }
  }

  window.CameraScan = { enabled: enabled, open: open };
})();
