@echo off
setlocal
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Install the package manager declared in package.json first.
  pause
  exit /b 1
)

call pnpm run handoff
set "exitCode=%errorlevel%"
echo.
if not "%exitCode%"=="0" echo Handoff backup failed with exit code %exitCode%.
pause
exit /b %exitCode%
