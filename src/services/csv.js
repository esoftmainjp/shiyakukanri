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

// CSV文字列を配列(オブジェクト)へパースする。ヘッダー行を key とする。
// 先頭BOM・ダブルクオート・改行入りフィールドに対応。
function parseCsv(text) {
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
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
      return obj;
    });
}

module.exports = { toCsv, sendCsv, parseCsv };
