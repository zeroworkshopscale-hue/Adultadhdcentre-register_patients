@echo off
REM Troubleshooting launcher (shows messages). For normal use, double-click the
REM desktop icon or "Start ADHD App.vbs", which runs with no windows.
title ADHD Intake App (setup view)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\dev.ps1"
echo.
echo If your browser opened the app, setup worked - you can close this window.
pause
