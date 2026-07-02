'use strict';

// GS1-128 バーコード解析ユーティリティ
// 構造例: (01)GTIN14 (17)使用期限YYMMDD (10)ロット ...
// 固定長AIは続けて読み、可変長AIはFNC1(GS=0x1D)または末尾で終端する。

const GS1_FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
const GS_CHAR = String.fromCharCode(29); // FNC1(GS)

// GS1-128らしい文字列か（(01)始まりで十分な長さ）
function isGs1(raw) {
  const s = String(raw || '').trim().replace(/^\]C1/, '').replace(/^\]d2/, '');
  return /^01\d{14}/.test(s) && s.length >= 16;
}

// 生文字列 → AIごとのオブジェクト { '01':..., '17':..., '10':... }
function parseGs1(raw) {
  // 一部スキャナが付与するシンボル識別子(]C1 等)を除去
  const s = String(raw || '').trim().replace(/^\]C1/, '').replace(/^\]d2/, '');
  let i = 0;
  const out = {};
  while (i < s.length) {
    const ai = s.substr(i, 2);
    i += 2;
    if (GS1_FIXED[ai] != null) {
      out[ai] = s.substr(i, GS1_FIXED[ai]);
      i += GS1_FIXED[ai];
    } else {
      let end = s.indexOf(GS_CHAR, i);
      if (end < 0) end = s.length;
      out[ai] = s.substring(i, end);
      i = (s[end] === GS_CHAR) ? end + 1 : end;
    }
  }
  return out;
}

// 使用期限 YYMMDD → 'YYYY-MM-DD' (日=00は月末)
function gs1ExpiryToDate(yymmdd) {
  if (!yymmdd || yymmdd.length < 6) return null;
  const yy = +yymmdd.slice(0, 2);
  const mm = +yymmdd.slice(2, 4);
  let dd = +yymmdd.slice(4, 6);
  const year = 2000 + yy;
  if (dd === 0) dd = new Date(year, mm, 0).getDate(); // 月末
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// 解析結果を業務用に整形して返す
function extractGs1(raw) {
  const p = parseGs1(raw);
  const gtin = p['01'] || '';
  return {
    gtin,                                   // GTIN-14
    jan: gtin.replace(/^0+/, ''),           // 先頭0除去(JAN13相当)
    lot: p['10'] || '',
    expiry: p['17'] ? gs1ExpiryToDate(p['17']) : null,
    serial: p['21'] || null,
    raw: p,
  };
}

// ブラウザ・Node両対応
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isGs1, parseGs1, gs1ExpiryToDate, extractGs1 };
}
