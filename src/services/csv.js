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

// CSVをトークナイズして「行(配列)の配列」にする。先頭BOM・ダブルクオート・改行入り
// フィールドに対応。全セルが空の行は除外する(ヘッダー有無の判定は呼び出し側)。
function tokenizeCsv(text) {
  let s = String(text == null ? '' : text).replace(/^﻿/, ''); // BOM除去
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
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// ヘッダー行あり前提で {headers, records} に分解(従来互換)。
function parseCsvRaw(text) {
  const rows = tokenizeCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => String(h).replace(/^﻿/, '').trim());
  return { headers, records: rows.slice(1) };
}

// CSV文字列を配列(オブジェクト)へパースする。ヘッダー行を key とする(従来互換)。
function parseCsv(text) {
  const { headers, records } = parseCsvRaw(text);
  return records.map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

// ---- 値の種別判定(列内容から項目を推測・検証するため) ----
const _sv = (v) => String(v == null ? '' : v).trim();
function isEmpty(v) { return _sv(v) === ''; }
function isInt(v) { return /^-?\d+$/.test(_sv(v).replace(/,/g, '')); }
function isNum(v) { return /^-?\d+(\.\d+)?$/.test(_sv(v).replace(/,/g, '')); }
function isDate(v) {
  const s = _sv(v);
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}
function isJan(v) {
  // JANは数字のみ(空白は許容)。ハイフンは除去しない(日付 2026-01-01 を誤検出しないため)。
  const s = _sv(v).replace(/\s/g, '');
  return /^\d+$/.test(s) && [8, 12, 13, 14].includes(s.length);
}
const _BOOL = new Set(['1', '0', '○', '×', 'x', 'true', 'false', 'yes', 'no', 'y', 'n', 'はい', 'いいえ', '有', '無', 'あり', 'なし']);
function isBool(v) { return _BOOL.has(_sv(v).toLowerCase()); }
function isKana(v) { const s = _sv(v); return s !== '' && /^[ぁ-んァ-ヶゝゞ゛゜ー・\s]+$/.test(s); }

// 1列分の内容シグナル(非空値に占める各種別の割合)を返す。
function columnSignals(dataRows, c) {
  let n = 0, jan = 0, date = 0, int = 0, num = 0, bool = 0, kana = 0;
  for (const r of dataRows) {
    const v = r[c];
    if (isEmpty(v)) continue;
    n++;
    if (isJan(v)) jan++;
    if (isDate(v)) date++;
    if (isInt(v)) int++;
    if (isNum(v)) num++;
    if (isBool(v)) bool++;
    if (isKana(v)) kana++;
  }
  const f = (x) => (n ? x / n : 0);
  return { n, jan: f(jan), date: f(date), int: f(int), num: f(num), bool: f(bool), kana: f(kana) };
}

// ヘッダー名の表記ゆらぎを吸収する正規化キー(NFKC・空白除去・小文字化)。
function normHeaderKey(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}
// フィールド定義(field＋aliases)から「正規化キー → field」の対応表を作る。
function buildNameLookup(fieldSpecs) {
  const map = new Map();
  for (const f of fieldSpecs) {
    for (const name of [f.field, ...(f.aliases || [])]) {
      const k = normHeaderKey(name);
      if (!map.has(k)) map.set(k, f.field);
    }
  }
  return map;
}
// 位置の項目(type)に対して、その列の内容が概ね合致するか。
function positionFits(sig, type) {
  if (sig.n === 0) return true; // 全て空は判定不能→列順を尊重
  switch (type) {
    case 'int': return sig.int >= 0.5;
    case 'num': return sig.num >= 0.5;
    case 'date': return sig.date >= 0.5;
    case 'jan': return sig.jan >= 0.5;
    default: return true; // text/kana/bool は内容で否定しない
  }
}
// 内容が際立って JAN/日付 の列なら、その項目名を返す(なければ null)。
function distinctiveField(sig, fieldSpecs) {
  if (sig.jan >= 0.8) { const f = fieldSpecs.find((x) => x.type === 'jan'); if (f) return f.field; }
  if (sig.date >= 0.8) { const f = fieldSpecs.find((x) => x.type === 'date'); if (f) return f.field; }
  return null;
}

// 列を項目(field)へ割り当てる。方針: 基本は「列順」を尊重し、疑わしいときだけ「列名」で判定。
//   ・通常(列順が妥当): 列index i → 標準の i 番目の項目。
//   ・疑わしい(内容が位置の型に合わない/明らかにJAN・日付/列名が別項目を示す)場合:
//       列名(別名含む)が項目を示せばそれを採用。示せなければ内容(JAN/日付)で補正、無ければ列順のまま。
// fieldSpecs: [{ field, type, required, aliases }]。headerRow: ヘッダー行(無ければ null)。
function inferColumns(dataRows, fieldSpecs, headerRow) {
  const nCols = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
  const fields = fieldSpecs.map((f) => f.field);
  const typeOf = {}; fieldSpecs.forEach((f) => { typeOf[f.field] = f.type; });
  const nameLookup = buildNameLookup(fieldSpecs);
  const sig = [];
  for (let c = 0; c < nCols; c++) sig.push(columnSignals(dataRows, c));

  // 各列の希望割当(field)と優先度(prio)を決める。prio大が競合に勝つ。
  const pref = new Array(nCols);
  for (let c = 0; c < nCols; c++) {
    const pos = c < fields.length ? fields[c] : null;
    const nm = headerRow ? (nameLookup.get(normHeaderKey(headerRow[c] !== undefined ? headerRow[c] : '')) || null) : null;
    let doubtful = false;
    if (!pos) doubtful = true;
    else {
      if (!positionFits(sig[c], typeOf[pos])) doubtful = true;         // 内容が位置の型に合わない
      if (typeOf[pos] !== 'jan' && sig[c].jan >= 0.8) doubtful = true; // 明らかにJANが別位置
      if (typeOf[pos] !== 'date' && sig[c].date >= 0.8) doubtful = true; // 明らかに日付が別位置
      if (nm && nm !== pos) doubtful = true;                          // 列名が別項目を示す
    }
    if (!doubtful) { pref[c] = { field: pos, prio: 2 }; }             // 列順(通常)
    else if (nm) { pref[c] = { field: nm, prio: 3 }; }                // 疑わしい→列名
    else { const dc = distinctiveField(sig[c], fieldSpecs); pref[c] = dc ? { field: dc, prio: 2 } : { field: pos, prio: 1 }; }
  }

  // 競合解決: 優先度の高い順に確定。あぶれた列は列順で未使用項目へ。
  const assign = new Array(nCols).fill(null);
  const used = new Set();
  const leftover = [];
  const order = [...Array(nCols).keys()].sort((a, b) => (pref[b].prio - pref[a].prio) || (a - b));
  for (const c of order) {
    const f = pref[c].field;
    if (f && !used.has(f)) { assign[c] = f; used.add(f); }
    else leftover.push(c);
  }
  leftover.sort((a, b) => a - b);
  let fi = 0;
  for (const c of leftover) {
    while (fi < fields.length && used.has(fields[fi])) fi++;
    if (fi < fields.length) { assign[c] = fields[fi]; used.add(fields[fi]); fi++; }
  }
  return assign;
}

// クライアント指定の割当(列→field名/空)を検証して正規化(不正・重複は無視)。
function normalizeMapping(m, nCols, fieldSpecs) {
  const valid = new Set(fieldSpecs.map((f) => f.field));
  const used = new Set();
  const out = [];
  for (let c = 0; c < nCols; c++) {
    let f = m[c];
    if (!valid.has(f) || used.has(f)) f = null;
    if (f) used.add(f);
    out.push(f || null);
  }
  return out;
}

// 割当に従って各データ行を {field:value} のオブジェクトへ(未割当項目は '')。
function buildRowObjects(dataRows, assign, fieldSpecs) {
  return dataRows.map((r) => {
    const o = {};
    for (const f of fieldSpecs) o[f.field] = '';
    assign.forEach((field, c) => {
      if (field && o[field] === '') o[field] = r[c] !== undefined ? r[c] : '';
    });
    return o;
  });
}

// 1値の検証。問題があればエラーメッセージ、無ければ null。空は(必須以外)許容。
function validateValue(v, spec) {
  const s = _sv(v);
  if (spec.required && s === '') return '必須です';
  if (s === '') return null;
  switch (spec.type) {
    case 'int': return isInt(s) ? null : '整数で入力してください';
    case 'num': return isNum(s) ? null : '数値で入力してください';
    case 'date': return isDate(s) ? null : '日付(YYYY-MM-DD)で入力してください';
    case 'jan': return isJan(s) ? null : 'JAN(8〜14桁の数字)で入力してください';
    default: return null; // text/kana/bool は自由
  }
}

// 全行を検証。戻り値: [{ line, field, value, error }]
function validateRows(rowObjs, fieldSpecs, lineOffset) {
  const errs = [];
  rowObjs.forEach((o, idx) => {
    const line = idx + lineOffset;
    for (const f of fieldSpecs) {
      const e = validateValue(o[f.field], f);
      if (e) errs.push({ line, field: f.field, value: _sv(o[f.field]), error: e });
    }
  });
  return errs;
}

// 割当の表示情報。mapped:[{col,header,field}] / ignored:[列名]
function mappingInfo(assign, headerRow) {
  const mapped = [];
  const ignored = [];
  assign.forEach((field, c) => {
    const h = headerRow && headerRow[c] !== undefined ? String(headerRow[c]).trim() : '';
    const label = h !== '' ? h : `列${c + 1}`;
    if (field) mapped.push({ col: c, header: label, field });
    else ignored.push(label);
  });
  return { mapped, ignored };
}

// CSVを解析(列名は使わず内容で推測、または指定mappingで割当)し、行オブジェクトと検証結果を返す。
// opts: { hasHeader=true, mapping }
function analyzeCsv(text, fieldSpecs, opts = {}) {
  const hasHeader = opts.hasHeader !== false;
  const rows = tokenizeCsv(text);
  const lineOffset = hasHeader ? 2 : 1;
  if (rows.length === 0 || (hasHeader && rows.length === 1)) {
    return { headerRow: hasHeader ? (rows[0] || null) : null, dataRows: [], assign: [], rows: [], errors: [], mapping: { mapped: [], ignored: [] }, rowCount: 0, lineOffset };
  }
  const headerRow = hasHeader ? rows[0] : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const nCols = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
  const assign = Array.isArray(opts.mapping)
    ? normalizeMapping(opts.mapping, nCols, fieldSpecs)
    : inferColumns(dataRows, fieldSpecs, headerRow);
  const rowObjs = buildRowObjects(dataRows, assign, fieldSpecs);
  const errors = validateRows(rowObjs, fieldSpecs, lineOffset);
  return { headerRow, dataRows, assign, rows: rowObjs, errors, mapping: mappingInfo(assign, headerRow), rowCount: rowObjs.length, lineOffset };
}

module.exports = {
  toCsv, sendCsv, parseCsv, parseCsvRaw, tokenizeCsv,
  analyzeCsv, inferColumns, buildRowObjects, validateRows, validateValue,
};
