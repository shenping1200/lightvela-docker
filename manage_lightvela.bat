@echo off
REM ============================================================
REM LightVela local app - management menu (start list)
REM Usage: double-click this file, pick [1] start [2] restart [3] stop [4] status [0] exit
REM ============================================================
:menu
cls
echo ============================================
echo    LightVela 本机程序管理
echo ============================================
echo    [1] 启动
echo    [2] 重启
echo    [3] 关闭
echo    [4] 状态
echo    [0] 退出
echo ============================================
set /p choice="请选择 [0-4]: "
if "%choice%"=="1" goto do_start
if "%choice%"=="2" goto do_restart
if "%choice%"=="3" goto do_stop
if "%choice%"=="4" goto do_status
if "%choice%"=="0" exit /b
echo 无效选择，请重新输入
timeout /t 1 /nobreak >nul
goto :menu

:do_start
call "%~dp0start_lightvela.bat"
goto after

:do_restart
call "%~dp0restart_lightvela.bat"
goto after

:do_stop
call "%~dp0stop_lightvela.bat"
goto after

:do_status
call "%~dp0status_lightvela.bat"
goto after

:after
echo.
pause
goto :menu
