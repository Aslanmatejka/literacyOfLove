@echo off
REM Open the simulation in Blender 4.2 LTS
setlocal
set "BLEND=%~dp0output\kids_daily_routine.blend"
set "PORTABLE=%~dp0tools\blender-4.2.9-windows-x64\blender.exe"
set "STORE=%LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe"

if exist "%PORTABLE%" (
  start "" "%PORTABLE%" "%BLEND%"
  exit /b 0
)
if exist "%STORE%" (
  start "" "%STORE%" "%BLEND%"
  exit /b 0
)

echo Could not find Blender 4.2.
echo Install Blender 4.2 LTS from the Microsoft Store, or extract portable Blender into tools\
pause
