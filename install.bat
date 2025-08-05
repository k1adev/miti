@echo off
setlocal enabledelayedexpansion

echo ========================================
echo    Instalador do Apoli - Sistema de Gestao
echo ========================================
echo.

:: Verificar se está no diretório correto
if not exist "package.json" (
    echo ERRO: Execute este script na pasta raiz do projeto!
    echo Certifique-se de que o arquivo package.json existe.
    pause
    exit /b 1
)

:: Verificar Node.js
echo [1/5] Verificando Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERRO: Node.js nao encontrado!
    echo Por favor, instale o Node.js versao 16 ou superior de: https://nodejs.org/
    echo Versao recomendada: LTS (Long Term Support)
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo Node.js encontrado: !NODE_VERSION!
echo.

:: Verificar npm
echo [2/5] Verificando npm...
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERRO: npm nao encontrado!
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo npm encontrado: !NPM_VERSION!
echo.

:: Limpar instalações anteriores
echo [3/5] Limpando instalacoes anteriores...
if exist "node_modules" (
    echo Removendo node_modules do backend...
    rmdir /s /q node_modules
)
if exist "client\node_modules" (
    echo Removendo node_modules do frontend...
    rmdir /s /q client\node_modules
)
if exist "client\build" (
    echo Removendo build anterior...
    rmdir /s /q client\build
)
echo.

:: Instalar dependências do backend
echo [4/5] Instalando dependencias do backend...
call npm install
if %errorlevel% neq 0 (
    echo ERRO: Falha ao instalar dependencias do backend!
    echo Verifique sua conexao com a internet e tente novamente.
    pause
    exit /b 1
)
echo Dependencias do backend instaladas com sucesso!
echo.

:: Instalar dependências do frontend
echo [5/5] Instalando dependencias do frontend...
cd client
call npm install
if %errorlevel% neq 0 (
    echo ERRO: Falha ao instalar dependencias do frontend!
    echo Verifique sua conexao com a internet e tente novamente.
    cd ..
    pause
    exit /b 1
)
cd ..
echo Dependencias do frontend instaladas com sucesso!
echo.

:: Criar arquivo de configuração se não existir
if not exist ".env" (
    echo Criando arquivo de configuracao...
    copy "env.example" ".env" >nul
    echo Arquivo .env criado com configuracoes padrao.
    echo.
)

:: Criar pasta de uploads se não existir
if not exist "uploads" (
    echo Criando pasta de uploads...
    mkdir uploads
)

echo ========================================
echo    Instalacao concluida com sucesso!
echo ========================================
echo.
echo Para iniciar a aplicacao:
echo.
echo Opcao 1 - Desenvolvimento (recomendado):
echo   npm run dev
echo.
echo Opcao 2 - Producao:
echo   npm start
echo.
echo Opcao 3 - Com Electron (aplicacao desktop):
echo   npm run electron
echo.
echo A aplicacao estara disponivel em:
echo - Local: http://localhost:3001
echo - Rede: http://[SEU_IP]:3001
echo.
echo Para encontrar seu IP na rede, execute: ipconfig
echo.
echo Pressione qualquer tecla para continuar...
pause >nul 