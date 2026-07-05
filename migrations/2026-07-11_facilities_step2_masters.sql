-- 施設別管理(マルチテナント) Step 2: マスタの施設スコープ化
--   対象: 問屋(suppliers)・メーカー(makers)・部門(departments)・分類(categories)
--         ・商品(products)・商品詳細(product_details)
-- 各マスタに facility_id を追加し、既存データは「既定施設」(facilities最小ID)へ割当。
-- 冪等: 既存列があれば追加しない。割当は facility_id が NULL の行のみ。

CREATE TABLE IF NOT EXISTS facilities (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    kana       VARCHAR(255) NOT NULL DEFAULT '',
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 万一 既定施設が無ければ作成(Step1未実施環境の保険)
INSERT INTO facilities (name)
SELECT COALESCE(NULLIF((SELECT value FROM app_settings WHERE key = 'company_name'), ''), 'テスト施設')
WHERE NOT EXISTS (SELECT 1 FROM facilities);

-- 問屋
ALTER TABLE suppliers       ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
UPDATE suppliers       SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_facility       ON suppliers(facility_id);

-- メーカー
ALTER TABLE makers          ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
UPDATE makers          SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_makers_facility          ON makers(facility_id);

-- 部門
ALTER TABLE departments     ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
UPDATE departments     SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_departments_facility     ON departments(facility_id);

-- 分類
ALTER TABLE categories      ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
UPDATE categories      SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_categories_facility      ON categories(facility_id);

-- 商品
ALTER TABLE products        ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
UPDATE products        SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_facility        ON products(facility_id);

-- 商品詳細
ALTER TABLE product_details ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
UPDATE product_details SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_details_facility ON product_details(facility_id);
