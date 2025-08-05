@echo off
echo ========================================
echo    DEPLOY APOLI - SISTEMA DE GESTAO
echo ========================================
echo.

echo [1/4] Instalando dependencias...
call npm run install-all
if errorlevel 1 (
    echo ERRO: Falha ao instalar dependencias
    pause
    exit /b 1
)

echo.
echo [2/4] Construindo aplicacao...
cd client
call npm run build
cd ..
if errorlevel 1 (
    echo ERRO: Falha ao construir aplicacao
    pause
    exit /b 1
)

echo.
echo [3/4] Verificando arquivos de deploy...
if not exist "vercel.json" (
    echo ERRO: Arquivo vercel.json nao encontrado
    pause
    exit /b 1
)

echo.
echo [4/4] Deploy concluido com sucesso!
echo.
echo Para fazer o deploy:
echo 1. Instale o Vercel CLI: npm i -g vercel
echo 2. Execute: vercel
echo 3. Siga as instrucoes na tela
echo.
echo Ou acesse: https://vercel.com
echo.
pause 