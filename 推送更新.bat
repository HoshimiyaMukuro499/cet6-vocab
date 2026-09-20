@echo off
cd /d "%~dp0"

echo.
echo   ===== 推送单词本更新 =====
echo.

echo [1/3] 用 Word 导出 PDF...
powershell -NoProfile -File "%~dp0tools\export-pdf.ps1"
if errorlevel 1 (
  echo.
  echo   [警告] PDF 导出失败，但 Word 文档仍会正常推送。
  echo          常见原因：Word 里开着弹窗对话框，把它点掉再试一次。
  echo.
)

echo [2/3] 提交改动...
git add -A
git commit -m "update"
if errorlevel 1 (
  echo.
  echo   没有检测到改动，跳过提交。
  echo.
)

echo [3/3] 推送到 GitHub...
git push
if errorlevel 1 (
  echo.
  echo   [失败] 推送没有成功，请检查网络后重试。
) else (
  echo.
  echo   完成。等约 30 秒，手机刷新就是最新版了。
)

echo.
pause
