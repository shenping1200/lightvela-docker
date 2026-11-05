@echo off
REM ============================================================
REM LightVela local app - status check
REM ============================================================
netstat -ano 2>nul | findstr ":8000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [LightVela] RUNNING on port 8000
) else (
  echo [LightVela] NOT running
)
