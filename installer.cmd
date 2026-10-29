@echo off
rem Installation de Lumen sur ce poste : double-cliquez ce fichier.
rem Le script PowerShell est autorise pour cette seule execution (ExecutionPolicy Bypass).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\installer.ps1" %*
pause
