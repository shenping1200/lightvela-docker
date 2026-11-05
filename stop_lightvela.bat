@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM LightVela local app - stop (kill webapp on port 8000 only)
REM Kills ONLY the webapp.py process listening on 8000; never touches jbl_keepalive / mailb.online
REM ============================================================
set "KILLED=0"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000 " ^| findstr "LISTENING"') do (
  if not "%%a"=="" (
    echo [LightVela] stopping webapp.py PID=%%a
    taskkill /PID %%a /F >nul 2>&1
    set "KILLED=1"
  )
)
if "!KILLED!"=="0" (
  echo [LightVela] nothing listening on port 8000, already stopped
)
endlocal
