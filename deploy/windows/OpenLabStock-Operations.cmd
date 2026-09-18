@echo off
setlocal
cd /d "%~dp0\..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0OpenLabStock-Operations.ps1" %*
set "exitCode=%errorlevel%"
if not "%exitCode%"=="0" (
  echo.
  echo OpenLabStock operation failed with exit code %exitCode%.
)
pause
exit /b %exitCode%
