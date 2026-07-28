'use strict';

// 配列データをCSV文字列に変換する。Excel(日本語)向けにUTF-8 BOMを付与する。
// columns: [{ key, label }]
function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(',')).join('\r\n');
  return '﻿' + header + '\r\n' + body + '\r\n';
}

// Expressレスポンスとして送出する
function sendCsv(res, filename, columns, rows) {
  const csv = toCsv(columns, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(csv);
}

// CSVをトークナイズして「ヘッダー配列」と「レコード(配列)配列」に分解する。
// 先頭BOM・ダブルクオート・改行入りフィールドに対応。全行空のレコードは除外する。
function parseCsvRaw(text) {
  let s = String(text).replace(/^﻿/, ''); // BOM除去
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { record.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { record.push(field); rows.push(record); field = ''; record = []; }
      else field += ch;
    }
  }
  if (field !== '' || record.length > 0) { record.push(field); rows.push(record); }
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => String(h).replace(/^﻿/, '').trim());
  const records = rows.slice(1).filter((r) => r.some((v) => String(v).trim() !== ''));
  return { headers, records };
}

// CSV文字列を配列(オブジェクト)へパースする。ヘッダー行を key とする。
function parseCsv(text) {
  const { headers, records } = parseCsvRaw(text);
  return records.map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

// ヘッダー名の表記ゆらぎを吸収するための正規化キー。
//   ・NFKC で全角→半角、半角カナ→全角カナ、全角数字→半角 などを統一
//   ・空白(内部含む)を除去、英字は小文字化
// これにより「ＪＡＮコード」「JAN コード」「ｶﾅ」なども同一視できる。
function normHeaderKey(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// フィールド定義から「正規化キー → 正規フィールド名」の対応表を作る。
// fieldDefs: [{ field:'名称', aliases:['商品名', ...] }, ...]
function buildHeaderLookup(fieldDefs) {
  const map = new Map();
  for (const def of fieldDefs) {
    for (const name of [def.field, ...(def.aliases || [])]) {
      const k = normHeaderKey(name);
      if (!map.has(k)) map.set(k, def.field); // 先に定義された対応を優先
    }
  }
  return map;
}

// 実際のヘッダー配列を、正規フィールド名へ対応付ける。
// 戻り値: colToField(列index→正規名/null)・recognized([{column,field}])・ignored([列名])
function mapHeaders(headers, fieldDefs) {
  const lookup = buildHeaderLookup(fieldDefs);
  const colToField = [];
  const recognized = [];
  const ignored = [];
  const usedFields = new Set();
  headers.forEach((h) => {
    const raw = String(h == null ? '' : h).trim();
    const field = lookup.get(normHeaderKey(raw));
    if (field && !usedFields.has(field)) {
      usedFields.add(field);
      recognized.push({ column: raw, field });
      colToField.push(field);
    } else {
      colToField.push(null);
      if (raw !== '') ignored.push(field ? `${raw}（重複）` : raw);
    }
  });
  return { colToField, recognized, ignored };
}

// フィールド定義(エイリアス・正規化)に基づいて CSV を取り込む。
// 各行は「正規フィールド名」を key とするオブジェクト(未指定列は '')。
// 戻り値: { rows, recognized, ignored, headers, rowCount }
function parseCsvMapped(text, fieldDefs) {
  const { headers, records } = parseCsvRaw(text);
  const { colToField, recognized, ignored } = mapHeaders(headers, fieldDefs);
  const rows = records.map((r) => {
    const obj = {};
    for (const def of fieldDefs) obj[def.field] = ''; // 既定は空
    colToField.forEach((field, i) => {
      if (field && (obj[field] === undefined || obj[field] === '')) {
        obj[field] = r[i] !== undefined ? r[i] : '';
      }
    });
    return obj;
  });
  return { rows, recognized, ignored, headers, rowCount: rows.length };
}

module.exports = { toCsv, sendCsv, parseCsv, parseCsvRaw, parseCsvMapped, normHeaderKey };
