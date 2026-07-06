-- 棚卸し機能(実地棚卸・在庫実数照合)
-- 冪等マイグレーション。ローカルは起動時 syncMigrations で自動適用、本番は手動:
--   node scripts/migrate.js --file migrations/2026-07-14_stocktake.sql
-- ddl_postgresql.sql(新規構築用)にも同内容を反映済み。

-- 1) 在庫移動区分に 'stocktake'(棚卸し差異) を追加
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD  CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('receipt', 'issue', 'adjust', 'disposal', 'return', 'stocktake'));

-- 2) 棚卸しヘッダ
CREATE TABLE IF NOT EXISTS stocktakes (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    facility_id  BIGINT      NOT NULL REFERENCES facilities(id),  -- 棚卸し対象施設(自前保持)
    title        VARCHAR(255) NOT NULL DEFAULT '',
    status       VARCHAR(16)  NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'counting', 'confirmed', 'canceled')),
    blind_flag   BOOLEAN      NOT NULL DEFAULT FALSE,   -- 将来用(理論在庫を隠すブラインド棚卸し)
    scope_note   TEXT         NOT NULL DEFAULT '',       -- 絞り込み条件(JSON文字列)
    started_by   BIGINT       REFERENCES users(id),
    confirmed_by BIGINT       REFERENCES users(id),
    started_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    canceled_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocktakes_facility ON stocktakes(facility_id);

DROP TRIGGER IF EXISTS trg_stocktakes_updated_at ON stocktakes;
CREATE TRIGGER trg_stocktakes_updated_at
    BEFORE UPDATE ON stocktakes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3) 棚卸し明細(粒度=商品×ロット×使用期限)
CREATE TABLE IF NOT EXISTS stocktake_lines (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stocktake_id    BIGINT      NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
    product_id      BIGINT      NOT NULL REFERENCES products(id),
    lot_number      VARCHAR(64) NOT NULL DEFAULT '',
    expiry_date     DATE,
    is_barcode      BOOLEAN     NOT NULL DEFAULT FALSE,   -- 開始時に active barcode 有無で凍結
    theoretical_qty INTEGER     NOT NULL DEFAULT 0,       -- 開始時の理論在庫を凍結(バラ個数)
    counted_qty     INTEGER,                              -- 実数(NULL=未カウント)
    counted_by      BIGINT      REFERENCES users(id),
    counted_at      TIMESTAMPTZ,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'counted', 'confirmed')),
    note            TEXT        NOT NULL DEFAULT '',
    CONSTRAINT uq_stocktake_lines UNIQUE NULLS NOT DISTINCT (stocktake_id, product_id, lot_number, expiry_date)
);
CREATE INDEX IF NOT EXISTS idx_stocktake_lines_take ON stocktake_lines(stocktake_id);

-- 4) バーコード個体スキャン記録
CREATE TABLE IF NOT EXISTS stocktake_scans (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stocktake_id  BIGINT      NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
    line_id       BIGINT      REFERENCES stocktake_lines(id) ON DELETE SET NULL,
    barcode_id    BIGINT      REFERENCES barcodes(id),
    barcode_value VARCHAR(64) NOT NULL,     -- 生のスキャン値(未登録でも残す)
    result        VARCHAR(24) NOT NULL
                  CHECK (result IN ('ok', 'used', 'voided', 'unknown', 'other_facility', 'other_lot', 'duplicate')),
    scanned_by    BIGINT      REFERENCES users(id),
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocktake_scans_take ON stocktake_scans(stocktake_id);
-- 同一棚卸しで同一個体の二重スキャンを検出(有効個体のみ)
CREATE UNIQUE INDEX IF NOT EXISTS uq_stocktake_scans_barcode
    ON stocktake_scans(stocktake_id, barcode_id) WHERE barcode_id IS NOT NULL;
