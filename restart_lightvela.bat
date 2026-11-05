@echo off
REM ============================================================
REM LightVela local app - restart (stop then start)
REM ============================================================
call "%~dp0stop_lightvela.bat"
timeout /t 2 /nobreak >nul
call "%~dp0start_lightvela.bat"
