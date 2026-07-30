-- 「永続」プランを追加。冪等・非破壊。
-- 支払義務なし・全機能・無制限。セルフ申込／プラン変更の対象外で、施設管理(全体管理者)でのみ選択する。
INSERT INTO plans (code, name, sort_order, max_users, max_products, log_retention_days,
                   feat_stocktake, feat_barcode, feat_reports, feat_ledger, feat_import, feat_billing, price)
VALUES ('permanent', '永続', 5, NULL, NULL, NULL, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, 0)
ON CONFLICT (code) DO NOTHING;
