@echo off
setlocal enabledelayedexpansion

echo ========================================
echo    Verificacao de Saude - Apoli Sistema
echo ========================================
echo.

:: Verificar se está no diretório correto
if not exist "package.json" (
    echo ERRO: Execute este script na pasta raiz do projeto!
    pause
    exit /b 1
)

echo [1/8] Verificando Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js nao encontrado!
    echo Por favor, instale o Node.js versao 16 ou superior.
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('node --version') do echo ✅ Node.js: %%i
)

echo.
echo [2/8] Verificando npm...
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ npm nao encontrado!
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('npm --version') do echo ✅ npm: %%i
)

echo.
echo [3/8] Verificando dependencias do backend...
if not exist "node_modules" (
    echo ❌ Dependencias do backend nao encontradas!
    echo Execute: install.bat
) else (
    echo ✅ Dependencias do backend encontradas
)

echo.
echo [4/8] Verificando dependencias do frontend...
if not exist "client\node_modules" (
    echo ❌ Dependencias do frontend nao encontradas!
    echo Execute: install.bat
) else (
    echo ✅ Dependencias do frontend encontradas
)

echo.
echo [5/8] Verificando build do frontend...
if not exist "client\build" (
    echo ⚠️  Build do frontend nao encontrado
    echo Execute: cd client && npm run build
) else (
    echo ✅ Build do frontend encontrado
)

echo.
echo [6/8] Verificando arquivo de configuracao...
if not exist ".env" (
    echo ⚠️  Arquivo .env nao encontrado
    echo Criando arquivo de configuracao padrao...
    copy "env.example" ".env" >nul
    echo ✅ Arquivo .env criado
) else (
    echo ✅ Arquivo .env encontrado
)

echo.
echo [7/8] Verificando banco de dados...
if not exist "database.sqlite" (
    echo ⚠️  Banco de dados nao encontrado
    echo Será criado automaticamente na primeira execução
) else (
    echo ✅ Banco de dados encontrado
)

echo.
echo [8/8] Verificando conectividade...
echo Testando porta 3001...
netstat -an | findstr :3001 >nul
if %errorlevel% equ 0 (
    echo ⚠️  Porta 3001 esta em uso
    echo Execute: taskkill /f /im node.exe
) else (
    echo ✅ Porta 3001 disponivel
)

echo.
echo ========================================
echo    Resumo da Verificacao
echo ========================================
echo.

:: Contar problemas
set /a problems=0
if not exist "node_modules" set /a problems+=1
if not exist "client\node_modules" set /a problems+=1
if not exist "client\build" set /a problems+=1
if not exist ".env" set /a problems+=1

if %problems% equ 0 (
    echo ✅ Sistema pronto para uso!
    echo.
    echo Para iniciar a aplicacao:
    echo - Desenvolvimento: npm run dev
    echo - Producao: npm start
    echo - Desktop: npm run electron
    echo - Script: start.bat
) else (
    echo ⚠️  Encontrados %problems% problema(s)
    echo.
    echo Para resolver:
    echo 1. Execute: install.bat
    echo 2. Execute: start.bat
)

echo.
echo Para mais informacoes, consulte o README.md
echo.
echo Pressione qualquer tecla para continuar...
pause >nul 