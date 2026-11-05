@echo off
cd /d "%~dp0"
set LV_PORT=8000
"C:\Users\Administrator\.workbuddy-ai\binaries\python\envs\default\Scripts\pythonw.exe" webapp.py >> webapp.log 2>&1
