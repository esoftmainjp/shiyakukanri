@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   試薬在庫管理システム DB初期化
echo ============================================
echo.
echo このバッチはテーブル作成と初期データ投入を行います。
echo ※初回セットアップ用です。既にテーブルがある場合はエラーになります。
echo.

if not exist ".env" (
  echo [警告] .env がありません。.env.example をコピーして設定してください。
  pause
  exit /b 1
)

set /p ans="初期化を実行しますか? (Y/N): "
if /i not "%ans%"=="Y" (
  echo 中止しました。
  pause
  exit /b 0
)

if not exist "node_modules" (
  echo 依存パッケージをインストールします...
  call npm install
  if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause
    exit /b 1
  )
)

echo テーブル作成と初期データ投入を実行します...
call npm run setup
if errorlevel 1 (
  echo [エラー] DB初期化に失敗しました。既存テーブルの有無やDB接続設定を確認してください。
  pause
  exit /b 1
)

echo.
echo 初期化が完了しました。start.bat で起動できます。
pause
endlocal