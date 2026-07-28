-- CSVインポートの「取込前に戻す(Undo)」用。冪等・非破壊。
-- 取込ごとに、その取込で新規作成した行のID群を記録する。
-- Undo は直近(未Undo)のバッチを対象に、記録した行だけを削除して取込前に戻す。
CREATE TABLE IF NOT EXISTS import_batches (
  id             BIGSERIAL   PRIMARY KEY,
  facility_id    BIGINT      NOT NULL REFERENCES facilities(id),
  import_type    VARCHAR(32) NOT NULL,                       -- products | product-details | products-combined
  created_by     BIGINT,
  product_ids    BIGINT[]    NOT NULL DEFAULT '{}',          -- この取込で新規作成した商品ID
  detail_ids     BIGINT[]    NOT NULL DEFAULT '{}',          -- この取込で新規作成した商品詳細ID
  department_ids BIGINT[]    NOT NULL DEFAULT '{}',          -- 自動追加した部門ID
  category_ids   BIGINT[]    NOT NULL DEFAULT '{}',          -- 自動追加した分類ID
  supplier_ids   BIGINT[]    NOT NULL DEFAULT '{}',          -- 自動追加した問屋ID
  maker_ids      BIGINT[]    NOT NULL DEFAULT '{}',          -- 自動追加したメーカーID
  shelf_ids      BIGINT[]    NOT NULL DEFAULT '{}',          -- 自動追加した棚ID
  summary        JSONB,                                      -- 件数などの概要
  undone         BOOLEAN     NOT NULL DEFAULT FALSE,         -- Undo済みか
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_batches_facility ON import_batches (facility_id, created_at DESC);

COMMENT ON TABLE  import_batches             IS 'CSV取込バッチ(取込前に戻す用。作成した行IDを保持)';
COMMENT ON COLUMN import_batches.import_type IS '取込種別(products/product-details/products-combined)';
COMMENT ON COLUMN import_batches.undone      IS 'Undo(取込前に戻す)済みフラグ';
