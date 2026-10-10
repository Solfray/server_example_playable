@echo off
setlocal
REM commit_sync_deploy.bat "commit message"
REM Stages everything, commits with the given message, pulls --rebase, pushes,
REM then deploys the Worker with Wrangler (npm run deploy).
REM Each step stops the script if it fails.

if "%~1"=="" (
  echo Usage: commit_sync_deploy.bat "commit message"
  exit /b 1
)

pushd "%~dp0"

echo === Stage and commit ===
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%~1"
  if errorlevel 1 goto :fail
) else (
  echo Nothing to commit; continuing with sync and deploy.
)

echo === Sync with remote ===
git pull --rebase
if errorlevel 1 goto :fail
git push
if errorlevel 1 goto :fail

echo === Deploy to Cloudflare ===
call npm.cmd run deploy
if errorlevel 1 goto :fail

echo === Done ===
popd
exit /b 0

:fail
echo.
echo *** Step failed (exit code %errorlevel%). Aborting. ***
popd
exit /b 1
