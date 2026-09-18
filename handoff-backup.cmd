@echo off
setlocal
cd /d "%~dp0"

where pnpm >nul 2>nul
if not errorlevel 1 (
  call pnpm run handoff
) else (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo Neither pnpm nor Corepack was found. Install Node.js 22.12 or newer first.
    pause
    exit /b 1
  )
  echo pnpm was not on PATH; using the repository-pinned version through Corepack.
  call corepack pnpm run handoff
)
set "exitCode=%errorlevel%"
echo.
if not "%exitCode%"=="0" echo Handoff backup failed with exit code %exitCode%.
pause
exit /b %exitCode%
