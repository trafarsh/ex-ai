@echo off
rem Installs Shot Exporter for Premiere Pro on Windows (unsigned, so CEP debug mode is turned on).
setlocal
set "SRC=%~dp0"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.trafarsh.shotexporter"

for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%"
xcopy "%SRC%CSXS" "%DEST%\CSXS\" /e /i /q /y >nul
xcopy "%SRC%css" "%DEST%\css\" /e /i /q /y >nul
xcopy "%SRC%js" "%DEST%\js\" /e /i /q /y >nul
xcopy "%SRC%jsx" "%DEST%\jsx\" /e /i /q /y >nul
copy /y "%SRC%index.html" "%DEST%\" >nul

echo Installed to: %DEST%
echo Restart Premiere Pro, then open Window ^> Extensions ^> Shot Exporter.
pause
