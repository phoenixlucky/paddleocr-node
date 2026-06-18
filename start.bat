@echo off
chcp 65001 2>NUL 1>NUL
title PaddleOCR Node - Web 服务
setlocal enabledelayedexpansion

:: 切换到脚本所在目录下的项目文件夹
cd /d "%~dp0paddleocr-node"
if errorlevel 1 (
    echo [错误] 未找到项目文件夹 paddleocr-node
    echo       请确保 start.bat 与 paddleocr-node 目录在同一层
    pause
    goto :eof
)

echo ============================================
echo   PaddleOCR Node - 一键启动
echo ============================================
echo.

:: ---------- 检查 Node.js ----------
node --version 2>NUL 1>NUL
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
    pause
    goto :eof
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js    : %%v

:: ---------- 检查 npm ----------
call npm --version 2>NUL 1>NUL
if errorlevel 1 (
    echo [错误] 未找到 npm
    pause
    goto :eof
)
for /f "delims=" %%v in ('call npm -v') do echo [OK] npm        : %%v

:: ---------- 检查 Python ----------
python --version 2>NUL 1>NUL
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python ^>= 3.8
    pause
    goto :eof
)
for /f "delims=" %%v in ('python --version 2^>^&1') do echo [OK] Python     : %%v
python -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)"
if errorlevel 1 (
    echo [错误] Python 版本过低，需要 Python ^>= 3.8
    pause
    goto :eof
)

echo.
echo ---------- 安装 npm 依赖 ----------
call npm install
if errorlevel 1 (
    echo [错误] npm install 失败，请检查网络或 package.json
    pause
    goto :eof
)
echo [OK] npm 依赖安装完成

echo.
echo ---------- 编译 TypeScript ----------
call npm run build
if errorlevel 1 (
    echo [错误] 编译失败，请检查 TypeScript 代码
    pause
    goto :eof
)
echo [OK] 编译完成

echo.
echo ---------- 启动 Web 服务 ----------
echo 打开浏览器访问：http://localhost:3100
echo 按 Ctrl+C 停止服务
echo.
call npm run web

echo.
echo [信息] Web 服务已停止。
pause
goto :eof
