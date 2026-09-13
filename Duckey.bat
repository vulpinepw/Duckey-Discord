@echo off
setlocal enabledelayedexpansion

set DISCORD_ROOT=%LocalAppData%\Discord

echo Duckey permanent installer
echo.

if not exist "%DISCORD_ROOT%" (
    echo Discord not found at %DISCORD_ROOT%
    pause
    exit /b 1
)

if not exist "%~dp0duckey.js" (
    echo Missing duckey.js next to this .bat
    pause
    exit /b 1
)

tasklist /FI "IMAGENAME eq Discord.exe" 2>nul | find /I "Discord.exe" >nul
if not errorlevel 1 (
    echo Closing Discord...
    taskkill /F /IM Discord.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
)

set LATEST=
for /f "delims=" %%i in ('dir /b /ad-h /o-n "%DISCORD_ROOT%\app-*" 2^>nul') do (
    if not defined LATEST set LATEST=%%i
)
if not defined LATEST (
    echo No Discord app folder found
    pause
    exit /b 1
)

set RESOURCES=%DISCORD_ROOT%\%LATEST%\resources
echo Target: %RESOURCES%
echo.

if exist "%RESOURCES%\original.asar" (
    echo Already patched for this version.
    pause
    exit /b 0
)

if not exist "%RESOURCES%\app.asar" (
    echo app.asar not found. Cannot patch.
    pause
    exit /b 1
)

if not exist "%RESOURCES%\app" mkdir "%RESOURCES%\app"

echo Copying payload...
copy /Y "%~dp0duckey.js" "%RESOURCES%\app\duckey.js" >nul

echo Writing shim manifest...
(
echo {
echo   "name": "discord-duckey",
echo   "version": "1.0.0",
echo   "main": "index.js",
echo   "private": true
echo }
) > "%RESOURCES%\app\package.json"

echo Writing shim loader...

> "%RESOURCES%\app\index.js" echo const { app } = require('electron');
>>"%RESOURCES%\app\index.js" echo const path = require('path');
>>"%RESOURCES%\app\index.js" echo const fs = require('fs');
>>"%RESOURCES%\app\index.js" echo.
>>"%RESOURCES%\app\index.js" echo const payloadPath = path.join(__dirname, 'duckey.js');
>>"%RESOURCES%\app\index.js" echo const payloadCode = fs.existsSync(payloadPath) ? fs.readFileSync(payloadPath, 'utf8') : null;
>>"%RESOURCES%\app\index.js" echo.
>>"%RESOURCES%\app\index.js" echo if (payloadCode) {
>>"%RESOURCES%\app\index.js" echo   app.on('browser-window-created', (event, window) =^> {
>>"%RESOURCES%\app\index.js" echo     window.webContents.on('did-finish-load', () =^> {
>>"%RESOURCES%\app\index.js" echo       try {
>>"%RESOURCES%\app\index.js" echo         const url = window.webContents.getURL() ^|^| '';
>>"%RESOURCES%\app\index.js" echo         if (url.includes('discord.com')) {
>>"%RESOURCES%\app\index.js" echo           window.webContents.executeJavaScript(payloadCode).catch((e) =^> console.error('[Duckey] inject failed:', e));
>>"%RESOURCES%\app\index.js" echo         }
>>"%RESOURCES%\app\index.js" echo       } catch (e) { console.error('[Duckey]', e); }
>>"%RESOURCES%\app\index.js" echo     });
>>"%RESOURCES%\app\index.js" echo   });
>>"%RESOURCES%\app\index.js" echo }
>>"%RESOURCES%\app\index.js" echo.
>>"%RESOURCES%\app\index.js" echo const originalAsar = path.join(__dirname, '..', 'original.asar');
>>"%RESOURCES%\app\index.js" echo if (fs.existsSync(originalAsar)) {
>>"%RESOURCES%\app\index.js" echo   require(originalAsar);
>>"%RESOURCES%\app\index.js" echo } else {
>>"%RESOURCES%\app\index.js" echo   console.error('[Duckey] original.asar not found');
>>"%RESOURCES%\app\index.js" echo }

echo Renaming app.asar to original.asar...
ren "%RESOURCES%\app.asar" "original.asar"

echo.
echo Done. Duckey is now permanent.
echo Launch Discord normally - it will load automatically.
echo.
pause