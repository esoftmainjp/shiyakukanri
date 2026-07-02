@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   試薬在庫管理システム 起動
echo ============================================

if not exist ".env" (
  echo [警告] .env がありません。.env.example をコピーして設定してください。
  echo 処理を中止します。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 初回セットアップ: 依存パッケージをインストールします...
  call npm install
  if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause
    exit /b 1
  )
)

echo ブラウザを起動します: http://localhost:3000
start "" http://localhost:3000

echo サーバーを起動します。停止するには この画面で Ctrl+C を押してください。
npm start

endlocal
pause