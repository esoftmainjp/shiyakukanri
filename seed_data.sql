-- ============================================================
-- 試薬在庫管理システム 初期データ (seed)
-- 文字コード: UTF-8
-- 前提: ddl_postgresql.sql 実行後に本スクリプトを実行する
--
-- パスワードは pgcrypto の bcrypt でハッシュ化する。
-- ※初期パスワードは運用開始時に必ず変更すること。
-- ============================================================

-- bcrypt(crypt/gen_salt) を使うための拡張
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ------------------------------------------------------------
-- 部門マスタ
-- ------------------------------------------------------------
INSERT INTO departments (name, kana) VALUES
    ('生化学', 'セイカガク'),
    ('免疫',   'メンエキ'),
    ('血液',   'ケツエキ'),
    ('一般',   'イッパン');

-- ------------------------------------------------------------
-- 分類マスタ
-- ------------------------------------------------------------
INSERT INTO categories (name, kana) VALUES
    ('試薬',           'シヤク'),
    ('消耗品',         'ショウモウヒン'),
    ('キャリブレーター', 'キャリブレーター'),
    ('コントロール',    'コントロール');

-- ------------------------------------------------------------
-- 問屋マスタ
-- ------------------------------------------------------------
INSERT INTO suppliers (name, kana) VALUES
    ('サンプル商事',       'サンプルショウジ'),
    ('メディカル物流',     'メディカルブツリュウ');

-- ------------------------------------------------------------
-- メーカーマスタ
-- ------------------------------------------------------------
INSERT INTO makers (name, kana, jan_maker_code) VALUES
    ('サンプル試薬',   'サンプルシヤク',   '4901234'),
    ('テスト診断薬',   'テストシンダンヤク', '4907654');

-- ------------------------------------------------------------
-- ユーザーマスタ (パスワードは bcrypt でハッシュ化)
--   admin    / Admin@12345
--   general  / General@123
--   supplier / Supplier@123
-- ------------------------------------------------------------
-- 初期ユーザーは管理者のみ。以降のユーザーは管理者が「マスター編集」から追加する。
-- 初期パスワードは既知の共通値のため、初回ログイン時に変更を必須とする(must_change_password=TRUE)。
INSERT INTO users (user_type, name, kana, login_id, password_hash, must_change_password) VALUES
    ('admin', '管理者', 'カンリシャ', 'admin', crypt('Admin@12345', gen_salt('bf', 10)), TRUE);

-- ------------------------------------------------------------
-- 商品マスター
-- ------------------------------------------------------------
INSERT INTO products (name, kana, department_id, category_id, management_code, qc_target_flag) VALUES
    ('GLU試薬',
        'ジーエルユーシヤク',
        (SELECT id FROM departments WHERE name = '生化学'),
        (SELECT id FROM categories  WHERE name = '試薬'),
        'GLU-001', TRUE),
    ('HbA1c試薬',
        'エイチビーエーワンシーシヤク',
        (SELECT id FROM departments WHERE name = '血液'),
        (SELECT id FROM categories  WHERE name = '試薬'),
        'HBA1C-001', TRUE),
    ('採血管',
        'サイケツカン',
        (SELECT id FROM departments WHERE name = '一般'),
        (SELECT id FROM categories  WHERE name = '消耗品'),
        'TUBE-001', FALSE);

-- ------------------------------------------------------------
-- 商品詳細マスター
--   GLU試薬   : 梱包数10, バーコード発行あり, 精度管理対象
--   HbA1c試薬 : 梱包数5,  バーコード発行あり
--   採血管    : 梱包数100, バーコード発行なし (ロット管理しない想定)
-- ------------------------------------------------------------
INSERT INTO product_details
    (product_id, apply_start_date, quantity_unit, pack_size, pack_unit, spec,
     unit_price, test_count, min_quantity, order_quantity, jan_code,
     maker_id, supplier_id, barcode_issue_flag)
VALUES
    ((SELECT id FROM products WHERE management_code = 'GLU-001'),
     DATE '2026-01-01', '本', 10, '箱', '40mL×2',
     3500, 200, 20, 1, '4901234000017',
     (SELECT id FROM makers    WHERE name = 'サンプル試薬'),
     (SELECT id FROM suppliers WHERE name = 'サンプル商事'),
     TRUE),
    ((SELECT id FROM products WHERE management_code = 'HBA1C-001'),
     DATE '2026-01-01', '本', 5, '箱', '3mL×4',
     8200, 100, 10, 1, '4901234000024',
     (SELECT id FROM makers    WHERE name = 'テスト診断薬'),
     (SELECT id FROM suppliers WHERE name = 'サンプル商事'),
     TRUE),
    ((SELECT id FROM products WHERE management_code = 'TUBE-001'),
     DATE '2026-01-01', '本', 100, '箱', '5mL',
     30, 0, 200, 1, '4907654000031',
     (SELECT id FROM makers    WHERE name = 'サンプル試薬'),
     (SELECT id FROM suppliers WHERE name = 'メディカル物流'),
     FALSE);

-- ------------------------------------------------------------
-- 商品在庫 (初期在庫の例。バラ個数で保持)
--   GLU試薬   : ロット/使用期限あり
--   採血管    : ロット・使用期限なし (空白=商品単位管理)
-- ------------------------------------------------------------
INSERT INTO product_stocks
    (product_id, lot_number, expiry_date, stock_quantity, first_receipt_date, last_receipt_date)
VALUES
    ((SELECT id FROM products WHERE management_code = 'GLU-001'),
     'LOT2026A', DATE '2027-03-31', 30, DATE '2026-07-01', DATE '2026-07-01'),
    ((SELECT id FROM products WHERE management_code = 'TUBE-001'),
     '', NULL, 500, DATE '2026-07-01', DATE '2026-07-01');

-- ------------------------------------------------------------
-- 運用設定 (初期値)
--   expiry_warn_days      : 使用期限の警告日数(この日数以内で警告)
--   allow_expired_issue   : 期限切れ商品の出庫を許可するか(true/false)
--   low_stock_threshold   : 在庫僅少アラートのしきい値(バラ数。0で無効)
--   company_*             : 自社情報(伝票・発注書ヘッダー)
--   label_*/barcode_*     : バーコードラベルの既定サイズ(全端末共通)
-- ------------------------------------------------------------
INSERT INTO app_settings (key, value) VALUES
    ('theme', 'blue'),
    ('expiry_warn_days', '30'),
    ('allow_expired_issue', 'false'),
    ('low_stock_threshold', '0'),
    ('company_name', ''),
    ('company_address', ''),
    ('company_tel', ''),
    ('company_person', ''),
    ('label_width_mm', '52'),
    ('label_height_mm', '29'),
    ('barcode_height_px', '60'),
    ('barcode_width_mm', '45'),
    ('label_barcode_font', '6'),
    ('label_name_font', '13'),
    ('label_sub_font', '13');

-- ============================================================
-- 以上
-- ============================================================
