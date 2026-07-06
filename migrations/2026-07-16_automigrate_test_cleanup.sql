-- 自動マイグレーション動作確認(2026-07-15_automigrate_test)の後片付け。
-- 検証用の一時テーブルを削除する(冪等)。
DROP TABLE IF EXISTS _automigrate_test;
