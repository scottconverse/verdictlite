@echo off
echo Installing VerdictLite...
powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://github.com/scottconverse/verdictlite/releases/latest/download/install.ps1 | iex"
if errorlevel 1 (
  echo.
  echo The install stopped. Read the message above.
)
echo.
pause
