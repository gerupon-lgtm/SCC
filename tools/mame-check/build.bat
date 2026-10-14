@echo off
rem Build the MAME comparison harness (T-006) with Visual Studio Build Tools cl.exe
setlocal
set VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS%" goto novc
call "%VCVARS%" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
cl /nologo /std:c++17 /O2 /EHsc /W3 /utf-8 /D_CRT_SECURE_NO_WARNINGS /I shim /I mame /Fe:build\harness.exe /Fo:build\ harness.cpp || exit /b 1
echo built build\harness.exe
cl /nologo /std:c++17 /O2 /EHsc /W3 /utf-8 /D_CRT_SECURE_NO_WARNINGS /I shim-ay /I mame /Fe:build\harness-ay.exe /Fo:build\ harness-ay.cpp || exit /b 1
echo built build\harness-ay.exe
exit /b 0
:novc
echo vcvars64.bat not found: "%VCVARS%"
exit /b 1
