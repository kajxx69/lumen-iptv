@echo off
rem Lance Lumen : double-cliquez ce fichier (ou le raccourci "Lumen" du Bureau).
if not exist "%~dp0data\lancer-lumen.ps1" (
  echo Lumen n'est pas encore installe sur ce poste : lancez d'abord installer.cmd.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0data\lancer-lumen.ps1"
pause
