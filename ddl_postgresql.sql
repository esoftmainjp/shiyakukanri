-- ============================================================
-- 試薬在庫管理システム DDL (PostgreSQL 15 以降)
-- 文字コード: UTF-8
-- 対応設計書: 試薬在庫管理システム_修正版設計書.txt
--
-- 命名規則: テーブル・カラムは英語、説明は COMMENT(日本語) で付与
-- 数量は原則バラ個数(最小単位)。梱包数・単価は取引時点のスナップショット。
-- ============================================================

-- ------------------------------------------------------------
-- 共通: updated_at 自動更新トリガー関数
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- マスター系
-- ============================================================

-- 7. 問屋マスタ
CREATE TABLE suppliers (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    kana        VARCHAR(255) NOT NULL DEFAULT '',
    note        TEXT         NOT NULL DEFAULT '',
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE  suppliers        IS '問屋マスタ';
COMMENT ON COLUMN suppliers.name   IS '名称';
COMMENT ON COLUMN suppliers.kana   IS 'カナ名称';
COMMENT ON COLUMN suppliers.note   IS '備考';
COMMENT ON COLUMN suppliers.is_active IS '有効フラグ';

-- 8. メーカーマスタ
CREATE TABLE makers (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    kana            VARCHAR(255) NOT NULL DEFAULT '',
    jan_maker_code  VARCHAR(32)  NOT NULL DEFAULT '',
    note            TEXT         NOT NULL DEFAULT '',
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE  makers                 IS 'メーカーマスタ';
COMMENT ON COLUMN makers.name            IS '名称';
COMMENT ON COLUMN makers.kana            IS 'カナ名称';
COMMENT ON COLUMN makers.jan_maker_code  IS 'JANメーカーコード';
COMMENT ON COLUMN makers.note            IS '備考';
COMMENT ON COLUMN makers.is_active       IS '有効フラグ';

-- 9. 部門マスタ
CREATE TABLE departments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    kana        VARCHAR(255) NOT NULL DEFAULT '',
    note        TEXT         NOT NULL DEFAULT '',
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE  departments      IS '部門マスタ';
COMMENT ON COLUMN departments.name IS '名称';
COMMENT ON COLUMN departments.kana IS 'カナ名称';
COMMENT ON COLUMN departments.note IS '備考';
COMMENT ON COLUMN departments.is_active IS '有効フラグ';

-- 10. 分類マスタ
CREATE TABLE categories (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    kana        VARCHAR(255) NOT NULL DEFAULT '',
    note        TEXT         NOT NULL DEFAULT '',
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE  categories      IS '分類マスタ';
COMMENT ON COLUMN categories.name IS '名称';
COMMENT ON COLUMN categories.kana IS 'カナ名称';
COMMENT ON COLUMN categories.note IS '備考';
COMMENT ON COLUMN categories.is_active IS '有効フラグ';

-- 11. ユーザーマスタ
CREATE TABLE users (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_type       VARCHAR(16)  NOT NULL
                    CHECK (user_type IN ('admin', 'general', 'supplier')),
    name            VARCHAR(255) NOT NULL,
    kana            VARCHAR(255) NOT NULL DEFAULT '',
    login_id        VARCHAR(64)  NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    note            TEXT         NOT NULL DEFAULT '',
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_login_id UNIQUE (login_id)
);
COMMENT ON TABLE  users                IS 'ユーザーマスタ';
COMMENT ON COLUMN users.user_type      IS 'タイプ(admin=管理者/general=一般/supplier=問屋)';
COMMENT ON COLUMN users.name           IS '氏名';
COMMENT ON COLUMN users.kana           IS 'カナ';
COMMENT ON COLUMN users.login_id       IS 'ログインID';
COMMENT ON COLUMN users.password_hash  IS 'パスワードハッシュ(bcrypt等。平文保存禁止)';
COMMENT ON COLUMN users.note           IS '備考';
COMMENT ON COLUMN users.is_active      IS '有効フラグ';

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 12. 商品マスター
CREATE TABLE products (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    kana                VARCHAR(255) NOT NULL DEFAULT '',
    department_id       BIGINT       REFERENCES departments(id),
    category_id         BIGINT       REFERENCES categories(id),
    management_code     VARCHAR(64)  NOT NULL DEFAULT '',
    qc_target_flag      BOOLEAN      NOT NULL DEFAULT FALSE,
    note                TEXT         NOT NULL DEFAULT '',
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE  products                 IS '商品マスター';
COMMENT ON COLUMN products.name            IS '名称';
COMMENT ON COLUMN products.kana            IS 'カナ名称';
COMMENT ON COLUMN products.department_id   IS '部門ID';
COMMENT ON COLUMN products.category_id     IS '分類ID';
COMMENT ON COLUMN products.management_code IS '管理コード';
COMMENT ON COLUMN products.qc_target_flag  IS '精度管理対象フラグ';
COMMENT ON COLUMN products.note            IS '備考';
COMMENT ON COLUMN products.is_active       IS '有効フラグ';

-- 13. 商品詳細マスター (日付管理で1商品に複数設定)
CREATE TABLE product_details (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id          BIGINT      NOT NULL REFERENCES products(id),
    apply_start_date    DATE        NOT NULL,
    apply_end_date      DATE,
    quantity_unit       VARCHAR(32) NOT NULL DEFAULT '',
    pack_size           INTEGER     NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
    pack_unit           VARCHAR(32) NOT NULL DEFAULT '',
    spec                VARCHAR(255) NOT NULL DEFAULT '',
    unit_price          NUMERIC(12,2) NOT NULL DEFAULT 0,
    test_count          INTEGER     NOT NULL DEFAULT 0,
    min_quantity        INTEGER     NOT NULL DEFAULT 0,
    order_quantity      INTEGER     NOT NULL DEFAULT 0,
    jan_code            VARCHAR(32) NOT NULL DEFAULT '',
    maker_id            BIGINT      REFERENCES makers(id),
    supplier_id         BIGINT      REFERENCES suppliers(id),
    barcode_issue_flag  BOOLEAN     NOT NULL DEFAULT FALSE,
    note                TEXT        NOT NULL DEFAULT ''
);
COMMENT ON TABLE  product_details                    IS '商品詳細マスター(日付管理で1商品に複数設定)';
COMMENT ON COLUMN product_details.product_id         IS '商品ID';
COMMENT ON COLUMN product_details.apply_start_date   IS '適用開始日';
COMMENT ON COLUMN product_details.apply_end_date     IS '適用終了日';
COMMENT ON COLUMN product_details.quantity_unit      IS '数量単位(個/箱/本/巻/テスト/パック/枚等)';
COMMENT ON COLUMN product_details.pack_size          IS '梱包数';
COMMENT ON COLUMN product_details.pack_unit          IS '梱包単位';
COMMENT ON COLUMN product_details.spec               IS '規格';
COMMENT ON COLUMN product_details.unit_price         IS '単価';
COMMENT ON COLUMN product_details.test_count         IS 'テスト数';
COMMENT ON COLUMN product_details.min_quantity       IS '最低個数';
COMMENT ON COLUMN product_details.order_quantity     IS '発注個数';
COMMENT ON COLUMN product_details.jan_code           IS 'JANコード';
COMMENT ON COLUMN product_details.maker_id           IS 'メーカーID';
COMMENT ON COLUMN product_details.supplier_id        IS '問屋ID';
COMMENT ON COLUMN product_details.barcode_issue_flag IS 'バーコード発行フラグ';
COMMENT ON COLUMN product_details.note               IS '備考';

CREATE INDEX idx_product_details_product ON product_details(product_id);


-- ============================================================
-- 在庫系
-- ============================================================

-- 14. 商品在庫 (商品ID+ロット+使用期限が単位。バラ個数で保持)
CREATE TABLE product_stocks (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id          BIGINT      NOT NULL REFERENCES products(id),
    lot_number          VARCHAR(64) NOT NULL DEFAULT '',   -- 空白可(空文字=ロット管理せず商品単位)
    expiry_date         DATE,                              -- 空白可(NULL)
    stock_quantity      INTEGER     NOT NULL DEFAULT 0,    -- NULLは0として扱う
    first_receipt_date  DATE,
    last_receipt_date   DATE,
    last_issue_date     DATE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULLS NOT DISTINCT: 使用期限NULLでも同一商品の在庫行が重複しないようにする(PostgreSQL 15+)
    CONSTRAINT uq_product_stocks UNIQUE NULLS NOT DISTINCT (product_id, lot_number, expiry_date)
);
COMMENT ON TABLE  product_stocks                    IS '商品在庫(バラ個数で保持)';
COMMENT ON COLUMN product_stocks.product_id         IS '商品ID';
COMMENT ON COLUMN product_stocks.lot_number         IS 'ロット番号(空白可=空文字。空白はロット管理せず商品単位)';
COMMENT ON COLUMN product_stocks.expiry_date        IS '使用期限(空白可=NULL)';
COMMENT ON COLUMN product_stocks.stock_quantity     IS '在庫数(バラ個数。NULLは0として扱う)';
COMMENT ON COLUMN product_stocks.first_receipt_date IS '初回入庫日';
COMMENT ON COLUMN product_stocks.last_receipt_date  IS '最終入庫日';
COMMENT ON COLUMN product_stocks.last_issue_date    IS '最終出庫日';

CREATE INDEX idx_product_stocks_product ON product_stocks(product_id);
CREATE INDEX idx_product_stocks_expiry  ON product_stocks(expiry_date);

CREATE TRIGGER trg_product_stocks_updated_at
    BEFORE UPDATE ON product_stocks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 出庫系
-- ============================================================

-- 3. 出庫情報
CREATE TABLE issues (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_date  DATE        NOT NULL,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    note        TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  issues            IS '出庫情報';
COMMENT ON COLUMN issues.issue_date IS '出庫日';
COMMENT ON COLUMN issues.user_id    IS 'ユーザーID';
COMMENT ON COLUMN issues.note       IS '備考';

CREATE TRIGGER trg_issues_updated_at
    BEFORE UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. 出庫明細
CREATE TABLE issue_details (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id            BIGINT      NOT NULL REFERENCES issues(id),
    product_id          BIGINT      NOT NULL REFERENCES products(id),
    product_detail_id   BIGINT      REFERENCES product_details(id),
    lot_number          VARCHAR(64) NOT NULL DEFAULT '',
    expiry_date         DATE,
    issue_quantity      INTEGER     NOT NULL DEFAULT 1,   -- 入力単位での個数
    pack_size           INTEGER     NOT NULL DEFAULT 1,   -- 出庫時点の梱包数スナップショット
    -- 出庫合計数(バラ個数) = 出庫個数 × 梱包数
    issue_total_quantity INTEGER GENERATED ALWAYS AS (issue_quantity * pack_size) STORED,
    note                TEXT        NOT NULL DEFAULT ''
);
COMMENT ON TABLE  issue_details                      IS '出庫明細';
COMMENT ON COLUMN issue_details.issue_id             IS '出庫情報ID';
COMMENT ON COLUMN issue_details.product_id           IS '商品ID';
COMMENT ON COLUMN issue_details.product_detail_id    IS '商品詳細ID';
COMMENT ON COLUMN issue_details.lot_number           IS 'ロット番号';
COMMENT ON COLUMN issue_details.expiry_date          IS '使用期限';
COMMENT ON COLUMN issue_details.issue_quantity       IS '出庫個数(入力単位)';
COMMENT ON COLUMN issue_details.pack_size            IS '梱包数(出庫時点スナップショット)';
COMMENT ON COLUMN issue_details.issue_total_quantity IS '出庫合計数(バラ個数=出庫個数×梱包数)';
COMMENT ON COLUMN issue_details.note                 IS '備考';

CREATE INDEX idx_issue_details_issue   ON issue_details(issue_id);
CREATE INDEX idx_issue_details_product ON issue_details(product_id);


-- ============================================================
-- 発注系
-- ============================================================

-- 5. 発注情報 (1件=1問屋。出庫情報IDは持たない=発注予定中間テーブルで管理)
CREATE TABLE orders (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_date   DATE,
    supplier_id  BIGINT      NOT NULL REFERENCES suppliers(id),
    user_id      BIGINT      REFERENCES users(id),
    order_status VARCHAR(16) NOT NULL DEFAULT 'unordered'
                 CHECK (order_status IN ('unordered', 'ordered', 'received', 'canceled')),
    note         TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  orders              IS '発注情報(1件=1問屋)';
COMMENT ON COLUMN orders.order_date   IS '発注日';
COMMENT ON COLUMN orders.supplier_id  IS '問屋ID';
COMMENT ON COLUMN orders.user_id      IS 'ユーザーID';
COMMENT ON COLUMN orders.order_status IS '発注状態(unordered=未発注/ordered=発注済み/received=入庫済み/canceled=キャンセル)';
COMMENT ON COLUMN orders.note         IS '備考';

CREATE INDEX idx_orders_supplier ON orders(supplier_id);
CREATE INDEX idx_orders_status   ON orders(order_status);

CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. 発注明細
CREATE TABLE order_details (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id               BIGINT  NOT NULL REFERENCES orders(id),
    product_id             BIGINT  NOT NULL REFERENCES products(id),
    product_detail_id      BIGINT  REFERENCES product_details(id),
    planned_order_quantity INTEGER NOT NULL DEFAULT 0,  -- 推奨発注数(梱包単位)=出庫バラ合計÷梱包数(切上/最低1)
    order_quantity         INTEGER NOT NULL DEFAULT 0,  -- 実際の発注数(梱包単位)。初期値=発注予定数
    note                   TEXT    NOT NULL DEFAULT ''
);
COMMENT ON TABLE  order_details                        IS '発注明細';
COMMENT ON COLUMN order_details.order_id               IS '発注情報ID';
COMMENT ON COLUMN order_details.product_id             IS '商品ID';
COMMENT ON COLUMN order_details.product_detail_id      IS '商品詳細ID';
COMMENT ON COLUMN order_details.planned_order_quantity IS '発注予定数(梱包単位。出庫バラ合計÷梱包数,切上/最低1)';
COMMENT ON COLUMN order_details.order_quantity         IS '発注個数(梱包単位。実際の確定数,初期値=発注予定数)';
COMMENT ON COLUMN order_details.note                   IS '備考';

CREATE INDEX idx_order_details_order   ON order_details(order_id);
CREATE INDEX idx_order_details_product ON order_details(product_id);


-- ============================================================
-- 入庫系
-- ============================================================

-- 1. 入庫情報
CREATE TABLE receipts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_date DATE        NOT NULL,
    supplier_id  BIGINT      REFERENCES suppliers(id),
    user_id      BIGINT      NOT NULL REFERENCES users(id),
    order_id     BIGINT      REFERENCES orders(id),  -- 参考紐付け(任意)。明細単位は receipt_plans で管理
    note         TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  receipts              IS '入庫情報';
COMMENT ON COLUMN receipts.receipt_date IS '入庫日';
COMMENT ON COLUMN receipts.supplier_id  IS '問屋ID';
COMMENT ON COLUMN receipts.user_id      IS 'ユーザーID';
COMMENT ON COLUMN receipts.order_id     IS '発注情報ID(参考紐付け,任意)';
COMMENT ON COLUMN receipts.note         IS '備考';

CREATE TRIGGER trg_receipts_updated_at
    BEFORE UPDATE ON receipts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. 入庫明細
CREATE TABLE receipt_details (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_id            BIGINT      NOT NULL REFERENCES receipts(id),
    product_id            BIGINT      NOT NULL REFERENCES products(id),
    product_detail_id     BIGINT      REFERENCES product_details(id),
    lot_number            VARCHAR(64) NOT NULL DEFAULT '',
    expiry_date           DATE,
    receipt_quantity      INTEGER     NOT NULL DEFAULT 1,  -- 入力単位での個数
    pack_size             INTEGER     NOT NULL DEFAULT 1,  -- 入庫時点の梱包数スナップショット
    -- 在庫加算数(バラ個数) = 入庫個数 × 梱包数
    stock_added_quantity  INTEGER GENERATED ALWAYS AS (receipt_quantity * pack_size) STORED,
    unit_price            NUMERIC(12,2) NOT NULL DEFAULT 0, -- 入庫時点の単価スナップショット
    note                  TEXT        NOT NULL DEFAULT ''
);
COMMENT ON TABLE  receipt_details                      IS '入庫明細';
COMMENT ON COLUMN receipt_details.receipt_id           IS '入庫情報ID';
COMMENT ON COLUMN receipt_details.product_id           IS '商品ID';
COMMENT ON COLUMN receipt_details.product_detail_id    IS '商品詳細ID';
COMMENT ON COLUMN receipt_details.lot_number           IS 'ロット番号';
COMMENT ON COLUMN receipt_details.expiry_date          IS '使用期限';
COMMENT ON COLUMN receipt_details.receipt_quantity     IS '入庫個数(入力単位)';
COMMENT ON COLUMN receipt_details.pack_size            IS '梱包数(入庫時点スナップショット)';
COMMENT ON COLUMN receipt_details.stock_added_quantity IS '在庫加算数(バラ個数=入庫個数×梱包数)';
COMMENT ON COLUMN receipt_details.unit_price           IS '単価(入庫時点スナップショット)';
COMMENT ON COLUMN receipt_details.note                 IS '備考';

CREATE INDEX idx_receipt_details_receipt ON receipt_details(receipt_id);
CREATE INDEX idx_receipt_details_product ON receipt_details(product_id);


-- ============================================================
-- 中間テーブル
-- ============================================================

-- 18. 発注予定 (出庫→発注。出庫明細と発注明細を紐付け、出庫バラ数を管理)
CREATE TABLE order_plans (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_detail_id      BIGINT  NOT NULL REFERENCES issue_details(id),
    order_detail_id      BIGINT  NOT NULL REFERENCES order_details(id),
    issue_piece_quantity INTEGER NOT NULL DEFAULT 0,  -- この出庫明細が寄与したバラ個数
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  order_plans                      IS '発注予定(中間:出庫→発注)';
COMMENT ON COLUMN order_plans.issue_detail_id      IS '出庫明細ID(発注のもとになった出庫明細)';
COMMENT ON COLUMN order_plans.order_detail_id      IS '発注明細ID(集約先)';
COMMENT ON COLUMN order_plans.issue_piece_quantity IS '出庫バラ数(この出庫明細が寄与したバラ個数)';

CREATE INDEX idx_order_plans_issue_detail ON order_plans(issue_detail_id);
CREATE INDEX idx_order_plans_order_detail ON order_plans(order_detail_id);

-- 19. 入庫予定 (発注→入庫。発注明細と入庫明細を紐付け、入庫バラ数を管理。部分入庫対応)
CREATE TABLE receipt_plans (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_detail_id        BIGINT  NOT NULL REFERENCES order_details(id),
    receipt_detail_id      BIGINT  NOT NULL REFERENCES receipt_details(id),
    receipt_piece_quantity INTEGER NOT NULL DEFAULT 0,  -- この入庫明細で入庫したバラ個数
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  receipt_plans                        IS '入庫予定(中間:発注→入庫)';
COMMENT ON COLUMN receipt_plans.order_detail_id        IS '発注明細ID(対象)';
COMMENT ON COLUMN receipt_plans.receipt_detail_id      IS '入庫明細ID(実際に入庫した明細)';
COMMENT ON COLUMN receipt_plans.receipt_piece_quantity IS '入庫バラ数(この入庫明細で入庫したバラ個数)';

CREATE INDEX idx_receipt_plans_order_detail   ON receipt_plans(order_detail_id);
CREATE INDEX idx_receipt_plans_receipt_detail ON receipt_plans(receipt_detail_id);


-- ============================================================
-- バーコード・履歴・ログ
-- ============================================================

-- 16. バーコード管理 (独自バーコード1本=バラ1個の個体単位)
CREATE TABLE barcodes (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_detail_id BIGINT      NOT NULL REFERENCES receipt_details(id),
    product_id        BIGINT      NOT NULL REFERENCES products(id),
    barcode_value     VARCHAR(64) NOT NULL,
    issue_date        DATE        NOT NULL,
    date_code         CHAR(6)     NOT NULL,             -- YYMMDD
    serial_number     INTEGER     NOT NULL,             -- 日付単位の通し番号(NNNN)
    content_code      INTEGER     NOT NULL,             -- 内容物コード(商品ごとの通し番号)
    used_flag         BOOLEAN     NOT NULL DEFAULT FALSE,
    use_start_date    DATE,                             -- 使用開始日(=出庫日。出庫時に自動記録)
    use_end_date      DATE,                             -- 使用終了日(使用終了日登録画面で登録)
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_barcodes_value        UNIQUE (barcode_value),
    CONSTRAINT uq_barcodes_content_code UNIQUE (product_id, content_code)
);
COMMENT ON TABLE  barcodes                   IS 'バーコード管理(独自バーコード1本=バラ1個)';
COMMENT ON COLUMN barcodes.receipt_detail_id IS '入庫明細ID';
COMMENT ON COLUMN barcodes.product_id        IS '商品ID';
COMMENT ON COLUMN barcodes.barcode_value     IS 'バーコード値(日付コード+通し番号。一意)';
COMMENT ON COLUMN barcodes.issue_date        IS '発行日';
COMMENT ON COLUMN barcodes.date_code         IS '日付コード(YYMMDD)';
COMMENT ON COLUMN barcodes.serial_number     IS '通し番号(NNNN)';
COMMENT ON COLUMN barcodes.content_code      IS '内容物コード(商品ごとの通し番号)';
COMMENT ON COLUMN barcodes.used_flag         IS '使用済みフラグ';
COMMENT ON COLUMN barcodes.use_start_date    IS '使用開始日(=出庫日)';
COMMENT ON COLUMN barcodes.use_end_date      IS '使用終了日';

CREATE INDEX idx_barcodes_receipt_detail ON barcodes(receipt_detail_id);
CREATE INDEX idx_barcodes_product        ON barcodes(product_id);

-- 15. 在庫移動履歴
CREATE TABLE stock_movements (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id       BIGINT      NOT NULL REFERENCES products(id),
    lot_number       VARCHAR(64) NOT NULL DEFAULT '',
    expiry_date      DATE,
    movement_type    VARCHAR(16) NOT NULL
                     CHECK (movement_type IN ('receipt', 'issue', 'adjust', 'disposal', 'return')),
    quantity_change  INTEGER     NOT NULL,   -- バラ個数(増加は正、減少は負)
    quantity_before  INTEGER     NOT NULL,   -- バラ個数
    quantity_after   INTEGER     NOT NULL,   -- バラ個数
    related_id       BIGINT,                 -- 関連情報ID(入庫情報ID/出庫情報ID等。汎用のためFKなし)
    user_id          BIGINT      NOT NULL REFERENCES users(id),
    reason           TEXT        NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  stock_movements                 IS '在庫移動履歴';
COMMENT ON COLUMN stock_movements.product_id      IS '商品ID';
COMMENT ON COLUMN stock_movements.lot_number      IS 'ロット番号';
COMMENT ON COLUMN stock_movements.expiry_date     IS '使用期限';
COMMENT ON COLUMN stock_movements.movement_type   IS '移動区分(receipt=入庫/issue=出庫/adjust=調整/disposal=廃棄/return=返品)';
COMMENT ON COLUMN stock_movements.quantity_change IS '増減数(バラ個数。増加は正/減少は負)';
COMMENT ON COLUMN stock_movements.quantity_before IS '処理前在庫数(バラ個数)';
COMMENT ON COLUMN stock_movements.quantity_after  IS '処理後在庫数(バラ個数)';
COMMENT ON COLUMN stock_movements.related_id      IS '関連情報ID(入庫/出庫情報ID等)';
COMMENT ON COLUMN stock_movements.user_id         IS 'ユーザーID';
COMMENT ON COLUMN stock_movements.reason          IS '理由(廃棄/返品/調整減は必須)';

CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_type    ON stock_movements(movement_type);
CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);

-- 17. 操作ログ
CREATE TABLE operation_logs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT      REFERENCES users(id),
    target_table   VARCHAR(64) NOT NULL DEFAULT '',
    target_id      BIGINT,
    operation_type VARCHAR(32) NOT NULL DEFAULT '',  -- 登録/更新/削除/在庫調整/ログイン等
    before_data    JSONB,
    after_data     JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  operation_logs                IS '操作ログ';
COMMENT ON COLUMN operation_logs.user_id        IS 'ユーザーID';
COMMENT ON COLUMN operation_logs.target_table   IS '対象テーブル';
COMMENT ON COLUMN operation_logs.target_id      IS '対象ID';
COMMENT ON COLUMN operation_logs.operation_type IS '操作区分(登録/更新/削除/在庫調整/ログイン等)';
COMMENT ON COLUMN operation_logs.before_data    IS '変更前データ(JSON)';
COMMENT ON COLUMN operation_logs.after_data     IS '変更後データ(JSON)';

CREATE INDEX idx_operation_logs_user    ON operation_logs(user_id);
CREATE INDEX idx_operation_logs_created ON operation_logs(created_at);

-- 運用設定 (使用期限の警告日数、期限切れ出庫の許可など)
CREATE TABLE app_settings (
    key        VARCHAR(64)  PRIMARY KEY,
    value      VARCHAR(255) NOT NULL,
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE  app_settings       IS '運用設定(キーバリュー)';
COMMENT ON COLUMN app_settings.key   IS '設定キー';
COMMENT ON COLUMN app_settings.value IS '設定値(文字列)';

CREATE TRIGGER trg_app_settings_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 以上
-- ============================================================
