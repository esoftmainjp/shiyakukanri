試薬在庫管理システム 開発手順書
==================================================

■ 構成
  - サーバー : Node.js (Express)
  - DB       : PostgreSQL 15以降
  - 実行環境 : ローカル開発 / Render (本番)

■ ディレクトリ
  ddl_postgresql.sql   … テーブル定義 (DDL)
  seed_data.sql        … 初期データ
  scripts/migrate.js   … DDL / seed 実行スクリプト
  src/db.js            … DB接続プール
  src/server.js        … Expressサーバー (ログイン, ヘルスチェック, 在庫一覧サンプル)
  public/index.html    … 動作確認用の簡易画面
  render.yaml          … Renderデプロイ設定
  .env.example         … 環境変数サンプル

--------------------------------------------------
■ ローカルでの起動手順
--------------------------------------------------

1. PostgreSQL を用意し、データベースを作成する
     例: createdb reagent

2. 環境変数ファイルを作成する
     .env.example をコピーして .env を作成し、DATABASE_URL を自環境に合わせる
     (ローカルは PGSSL=false のままでよい)

3. 依存パッケージをインストールする
     npm install

4. テーブル作成 + 初期データ投入
     npm run setup
   (DDLのみ: npm run migrate  /  seedのみ: npm run seed)

5. サーバー起動
     npm start
     ブラウザで http://localhost:3000 を開く

6. 動作確認
     初期ユーザー admin / Admin@12345 でログインし、
     「在庫一覧を取得」ボタンでサンプル在庫が表示されれば成功。

--------------------------------------------------
■ Render へのデプロイ (Blueprint)
--------------------------------------------------

1. リポジトリを GitHub に push する
2. Render で「New +」→「Blueprint」から本リポジトリを選択する
   (render.yaml が読み込まれ、Web ServiceとPostgreSQLが作成される)
3. 初回のみ、DBにDDL/seedを流す
   - Render Shell もしくはローカルから、本番 DATABASE_URL を指定して実行する
     例(ローカルから): DATABASE_URL="<本番URL>" PGSSL=true npm run setup

--------------------------------------------------
■ 注意事項
--------------------------------------------------
  - 初期パスワードは運用開始時に必ず変更すること。
  - SESSION_SECRET は本番で十分に長いランダム値にすること (render.yamlでは自動生成)。
  - Renderの標準ファイルシステムは揮発性のため、データは必ずPostgreSQLに保存する。
  - セッションはメモリ保持のため、複数インスタンス運用時は
    connect-pg-simple 等でセッションストアをDB化すること (将来対応)。
