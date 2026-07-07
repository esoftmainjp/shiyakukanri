'use strict';

// 操作ログ閲覧API (管理者のみ。server.js で requireRole('admin') を適用)
const express = require('express');
const { pool } = require('../db');
const { sendCsv } = require('../services/csv');
const { facilityScope } = require('../services/facility');

const router = express.Router();

// 絞り込み条件(WHERE)を構築。GET / と /csv で共用。
// 施設スコープ: ログに記録された「操作施設」で限定する(全体管理者の操作も含む)。
function buildLogFilter(q, scope) {
  const conds = [];
  const params = [];
  const add = (frag, val) => { params.push(val); conds.push(frag.replace('$', '$' + params.length)); };
  if (scope && !scope.all) add('l.facility_id = $', scope.facilityId);
  if (q.from) add('l.created_at >= $', q.from);
  if (q.to) add("l.created_at < ($::date + INTERVAL '1 day')", q.to);
  if (q.userId) add('l.user_id = $', q.userId);
  if (q.operationType) add('l.operation_type = $', q.operationType);
  if (q.targetTable) add('l.target_table = $', q.targetTable);
  if (q.keyword) {
    params.push('%' + q.keyword + '%');
    const p = '$' + params.length;
    conds.push(`(l.target_table ILIKE ${p} OR l.operation_type ILIKE ${p}
                 OR l.before_data::text ILIKE ${p} OR l.after_data::text ILIKE ${p}
                 OR u.name ILIKE ${p} OR CAST(l.target_id AS TEXT) ILIKE ${p})`);
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// 対象テーブルの和名(表示用)
const TABLE_LABELS = {
  users: 'ユーザー',
  products: '商品',
  product_details: '商品詳細',
  suppliers: '問屋',
  makers: 'メーカー',
  departments: '部門',
  categories: '分類',
  facilities: '施設',
  receipts: '入庫',
  receipt_details: '入庫明細',
  issues: '出庫',
  issue_details: '出庫明細',
  orders: '発注',
  order_details: '発注明細',
  barcodes: 'バーコード',
  usage_records: '使用記録',
  stock_movements: '在庫変動',
  product_stocks: '在庫',
  app_settings: '設定',
  ledger: '試薬管理台帳',
  inventory: '在庫一覧',
  logs: '操作ログ',
  receipts_list: '入庫履歴', issues_list: '出庫履歴',
  orders_list: '発注履歴', movements_list: '在庫調整履歴',
  usage_report: '使用量集計', monthly_report: '月次推移',
};

// 対象テーブル→(id配列から)名称を引くSQL。ここに無いテーブルはID表示のまま。
const NAME_SQL = {
  suppliers:   'SELECT id, name FROM suppliers   WHERE id = ANY($1::bigint[])',
  makers:      'SELECT id, name FROM makers       WHERE id = ANY($1::bigint[])',
  departments: 'SELECT id, name FROM departments  WHERE id = ANY($1::bigint[])',
  categories:  'SELECT id, name FROM categories   WHERE id = ANY($1::bigint[])',
  products:    'SELECT id, name FROM products      WHERE id = ANY($1::bigint[])',
  users:       'SELECT id, name FROM users         WHERE id = ANY($1::bigint[])',
  facilities:  'SELECT id, name FROM facilities    WHERE id = ANY($1::bigint[])',
  product_details:
    "SELECT pd.id, (p.name || CASE WHEN pd.spec <> '' THEN ' ' || pd.spec ELSE '' END) AS name " +
    'FROM product_details pd JOIN products p ON p.id = pd.product_id WHERE pd.id = ANY($1::bigint[])',
  order_details:
    'SELECT od.id, p.name AS name FROM order_details od JOIN products p ON p.id = od.product_id WHERE od.id = ANY($1::bigint[])',
  barcodes:    'SELECT id, barcode_value AS name FROM barcodes WHERE id = ANY($1::bigint[])',
  receipts:    "SELECT id, ('入庫 ' || receipt_date) AS name FROM receipts WHERE id = ANY($1::bigint[])",
  issues:      "SELECT id, ('出庫 ' || issue_date)   AS name FROM issues   WHERE id = ANY($1::bigint[])",
  orders:      "SELECT id, ('発注 ' || COALESCE(order_date::text, '(未発注)')) AS name FROM orders WHERE id = ANY($1::bigint[])",
};

// ログ配列に、対象レコードの名称(target_name)を付与する。
async function attachTargetNames(items) {
  const byTable = {};
  for (const r of items) {
    if (r.target_id == null || !NAME_SQL[r.target_table]) continue;
    (byTable[r.target_table] ||= new Set()).add(String(r.target_id));
  }
  const nameMap = {};
  for (const [table, idSet] of Object.entries(byTable)) {
    try {
      const { rows } = await pool.query(NAME_SQL[table], [[...idSet]]);
      for (const row of rows) nameMap[`${table}:${row.id}`] = row.name;
    } catch (e) { /* 名称引き失敗時はID表示にフォールバック */ }
  }
  for (const r of items) {
    r.target_name = (r.target_id != null) ? (nameMap[`${r.target_table}:${r.target_id}`] || null) : null;
  }
  return items;
}

// ---- before/after データ内のフィールド名・ID値を日本語/名称へ変換する ----

// 変更前後データのキー(フィールド名)の和名。logs.html の KEY_LABELS と対応。
const FIELD_LABELS = {
  name: '名称', kana: 'カナ', note: '備考', is_active: '有効', login_id: 'ログインID', user_type: 'タイプ',
  password: 'パスワード', department_id: '部門', category_id: '分類', management_code: '管理コード', qc_target_flag: '試薬管理対象',
  product_id: '商品', supplier_id: '問屋', maker_id: 'メーカー', product_detail_id: '商品詳細',
  lot_number: 'ロット', expiry_date: '使用期限', unit_price: '単価', pack_size: '梱包数',
  quantity_unit: '数量単位', pack_unit: '梱包単位', spec: '規格', jan_code: 'JANコード',
  test_count: 'テスト数', min_quantity: '最低個数', order_quantity: '発注数', jan_maker_code: 'JANメーカーコード',
  stock_quantity: '在庫数', movementType: '区分', reason: '理由', receipt_date: '入庫日', issue_date: '出庫日',
  order_date: '発注日', order_status: '状態', apply_start_date: '適用開始日', apply_end_date: '適用終了日',
  barcode_issue_flag: 'バーコード発行', canceled_flag: 'キャンセル', held_flag: '保留',
  password_changed: 'パスワード変更', file: 'ファイル', count: '件数',
  productId: '商品', lotNumber: 'ロット', expiryDate: '使用期限',
  issueDate: '出庫日', receiptDate: '入庫日', orderDate: '発注日',
  detailCount: '明細件数', orderPlanCreated: '発注予定作成', receivedOrders: '入庫済み発注数',
  values: 'バーコード値', from: '開始日', to: '終了日', groupBy: '集計単位', via: '経由',
  admin_login_id: '管理者ログインID', order_id: '発注', planned_order_quantity: '予定数',
  title: 'タイトル', lineCount: '明細件数', scope: '絞り込み条件', status: '状態',
  confirmedLines: '反映件数', totalDiff: '差異合計', voidedBarcodes: '紛失無効化(本)',
  driftLines: '在庫変動件数', uncounted: '未カウント件数',
  inserted: '取込件数', skipped: 'スキップ件数',
  departmentsCreated: '部門作成数', categoriesCreated: '分類作成数',
  makersCreated: 'メーカー作成数', suppliersCreated: '問屋作成数',
  productsCreated: '商品作成数', detailsCreated: '商品詳細作成数',
  user_id: 'ユーザー', id: 'ID', created_at: '作成日時', updated_at: '更新日時',
};
const MOVE_LABEL = { adjust: '在庫調整', disposal: '廃棄', return: '返品', receipt: '入庫', issue: '出庫' };
const OSTATUS_LABEL = { unordered: '未発注', ordered: '発注済み', received: '入庫済み', canceled: 'キャンセル' };
const STATUS_LABEL = { open: '作成', counting: 'カウント中', confirmed: '確定', canceled: 'キャンセル', unordered: '未発注', ordered: '発注済み', received: '入庫済み' };
const UTYPE_LABEL = { superadmin: '全体管理者', admin: '管理者', general: '一般', supplier: '問屋' };

// before/after のキー(ID項目) → 名称を引くマスター種別(NAME_SQL のキー)
const ID_FIELD_TABLE = {
  product_id: 'products', productId: 'products',
  supplier_id: 'suppliers', supplierId: 'suppliers',
  maker_id: 'makers', makerId: 'makers',
  department_id: 'departments', departmentId: 'departments',
  category_id: 'categories', categoryId: 'categories',
  product_detail_id: 'product_details', productDetailId: 'product_details',
  user_id: 'users', userId: 'users',
  facility_id: 'facilities', facilityId: 'facilities',
  order_id: 'orders', orderId: 'orders',
  order_detail_id: 'order_details',
  barcode_id: 'barcodes', receipt_id: 'receipts', issue_id: 'issues',
};

// ログ配列の before_data/after_data 内のID項目を名称へ置換する(見つからなければIDのまま)。
async function resolveIdsInLogs(items) {
  const byTable = {};
  const scan = (data) => {
    if (!data || typeof data !== 'object') return;
    for (const [k, v] of Object.entries(data)) {
      const t = ID_FIELD_TABLE[k];
      if (t && NAME_SQL[t] && v != null && /^\d+$/.test(String(v))) {
        (byTable[t] ||= new Set()).add(String(v));
      }
    }
  };
  for (const r of items) { scan(r.before_data); scan(r.after_data); }
  const nameMap = {};
  for (const [t, idSet] of Object.entries(byTable)) {
    try {
      const { rows } = await pool.query(NAME_SQL[t], [[...idSet]]);
      for (const row of rows) nameMap[`${t}:${row.id}`] = row.name;
    } catch (e) { /* 名称引き失敗はIDのまま */ }
  }
  const apply = (data) => {
    if (!data || typeof data !== 'object') return data;
    const out = Array.isArray(data) ? data.slice() : { ...data };
    for (const [k, v] of Object.entries(out)) {
      const t = ID_FIELD_TABLE[k];
      if (t && v != null) {
        const nm = nameMap[`${t}:${v}`];
        if (nm != null) out[k] = nm;
      }
    }
    return out;
  };
  for (const r of items) { r.before_data = apply(r.before_data); r.after_data = apply(r.after_data); }
  return items;
}

// 単一値を和訳(区分・状態・タイプ・真偽・空)。
function fmtLogValue(k, v) {
  if (v === undefined) return '';
  if (v === null || v === '') return '(空)';
  if (typeof v === 'boolean') return k === 'is_active' ? (v ? '有効' : '無効') : (v ? 'はい' : 'いいえ');
  if (k === 'movementType') return MOVE_LABEL[v] || v;
  if (k === 'order_status') return OSTATUS_LABEL[v] || v;
  if (k === 'status') return STATUS_LABEL[v] || v;
  if (k === 'user_type') return UTYPE_LABEL[v] || v;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}

// before/after オブジェクトを「項目: 値 / …」の日本語文字列にする(CSV・印刷用)。
function formatLogText(data) {
  if (data == null) return '';
  if (typeof data !== 'object') return String(data);
  return Object.entries(data).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${fmtLogValue(k, v)}`).join(' / ');
}

// フィルタ用の候補(操作区分・対象テーブル・ユーザー)
// GET /api/logs/meta
router.get('/meta', async (req, res) => {
  try {
    // 施設スコープ: 絞り込み候補(操作種別・対象種別・ユーザー)もその施設のログ/利用者に限定する。
    const scope = facilityScope(req);
    const p = [];
    let facCond = '';
    if (!scope.all) { p.push(scope.facilityId); facCond = ' AND facility_id = $1'; }
    const ops = await pool.query(
      `SELECT DISTINCT operation_type FROM operation_logs WHERE operation_type <> ''${facCond} ORDER BY operation_type`,
      p
    );
    const tables = await pool.query(
      `SELECT DISTINCT target_table FROM operation_logs WHERE target_table <> ''${facCond} ORDER BY target_table`,
      p
    );
    const uParams = [];
    let uWhere = '';
    if (!scope.all) { uParams.push(scope.facilityId); uWhere = 'WHERE facility_id = $1'; }
    const users = await pool.query(
      `SELECT id, name, login_id FROM users ${uWhere} ORDER BY name`,
      uParams
    );
    res.json({
      operationTypes: ops.rows.map((r) => r.operation_type),
      targetTables: tables.rows.map((r) => ({ value: r.target_table, label: TABLE_LABELS[r.target_table] || r.target_table })),
      users: users.rows,
    });
  } catch (err) {
    console.error('操作ログmetaエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 操作ログの件数(施設スコープ)。全体管理者が施設未選択なら全施設合計。
// GET /api/logs/storage
router.get('/storage', async (req, res) => {
  try {
    const scope = facilityScope(req);
    const params = [];
    let where = '';
    if (!scope.all) { params.push(scope.facilityId); where = 'WHERE facility_id = $1'; }
    const r = await pool.query(`SELECT COUNT(*) AS c FROM operation_logs ${where}`, params);
    res.json({ count: Number((r.rows[0] || {}).c || 0) });
  } catch (err) {
    console.error('操作ログ件数エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 操作ログ一覧(絞り込み・ページング)
// GET /api/logs?from&to&userId&operationType&targetTable&keyword&limit&offset
router.get('/', async (req, res) => {
  const q = req.query;
  try {
    const { where, params } = buildLogFilter(q, facilityScope(req));

    const limit = Math.min(10000, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);

    const countRes = await pool.query(
      `SELECT COUNT(*) AS c FROM operation_logs l LEFT JOIN users u ON u.id = l.user_id ${where}`,
      params
    );
    const total = Number(countRes.rows[0].c);

    const listParams = params.slice();
    listParams.push(limit, offset);
    const rows = await pool.query(
      `SELECT l.id, l.created_at, l.user_id, u.name AS user_name, u.login_id,
              l.target_table, l.target_id, l.operation_type, l.before_data, l.after_data
         FROM operation_logs l
         LEFT JOIN users u ON u.id = l.user_id
         ${where}
        ORDER BY l.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const items = rows.rows.map((r) => ({
      ...r,
      target_table_label: TABLE_LABELS[r.target_table] || r.target_table,
    }));
    await attachTargetNames(items);
    await resolveIdsInLogs(items);
    // 印刷用に日本語整形テキストも付与(画面はbefore_data/after_dataの差分表を使用)
    for (const r of items) {
      r.before_text = formatLogText(r.before_data);
      r.after_text = formatLogText(r.after_data);
    }
    res.json({ items, total, limit, offset });
  } catch (err) {
    console.error('操作ログ一覧エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 操作ログCSV(絞り込みは一覧と同じ。ページングは無視し全件出力)
// GET /api/logs/csv?from&to&userId&operationType&targetTable&keyword
router.get('/csv', async (req, res) => {
  try {
    const { where, params } = buildLogFilter(req.query, facilityScope(req));
    const p = params.slice();
    p.push(50000);
    const { rows } = await pool.query(
      `SELECT l.id, l.created_at, u.name AS user_name, u.login_id,
              l.target_table, l.target_id, l.operation_type, l.before_data, l.after_data
         FROM operation_logs l
         LEFT JOIN users u ON u.id = l.user_id
         ${where}
        ORDER BY l.id DESC
        LIMIT $${p.length}`,
      p
    );
    await attachTargetNames(rows);
    await resolveIdsInLogs(rows);
    const data = rows.map((r) => ({
      created_at: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19) : '',
      user_name: r.user_name || '',
      login_id: r.login_id || '',
      operation_type: r.operation_type || '',
      target_table: TABLE_LABELS[r.target_table] || r.target_table || '',
      target_name: (r.target_name && r.target_name !== r.user_name) ? r.target_name : '',
      before_data: formatLogText(r.before_data),
      after_data: formatLogText(r.after_data),
    }));
    const columns = [
      { key: 'created_at', label: '日時' },
      { key: 'user_name', label: 'ユーザー' },
      { key: 'login_id', label: 'ログインID' },
      { key: 'operation_type', label: '操作' },
      { key: 'target_table', label: '対象' },
      { key: 'target_name', label: '内容' },
      { key: 'before_data', label: '変更前' },
      { key: 'after_data', label: '変更後' },
    ];
    sendCsv(res, '操作ログ.csv', columns, data);
  } catch (err) {
    console.error('操作ログCSVエラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
