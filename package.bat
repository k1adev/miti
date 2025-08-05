@echo off
setlocal enabledelayedexpansion

echo ========================================
echo    Empacotador do Apoli - Sistema de Gestao
echo ========================================
echo.

:: Verificar se está no diretório correto
if not exist "package.json" (
    echo ERRO: Execute este script na pasta raiz do projeto!
    pause
    exit /b 1
)

:: Verificar se as dependências estão instaladas
if not exist "node_modules" (
    echo ERRO: Dependencias nao encontradas!
    echo Execute primeiro: install.bat
    pause
    exit /b 1
)

:: Parar servidores em execução
echo [1/5] Parando servidores em execucao...
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Verificar se o build existe
echo [2/5] Verificando build do frontend...
if not exist "client\build" (
    echo Build nao encontrado. Criando build...
    cd client
    call npm run build
    if %errorlevel% neq 0 (
        echo ERRO: Falha ao criar build!
        cd ..
        pause
        exit /b 1
    )
    cd ..
) else (
    echo Build encontrado.
)
echo.

:: Verificar se o arquivo .env existe
echo [3/5] Verificando configuracoes...
if not exist ".env" (
    echo Criando arquivo de configuracao padrao...
    copy "env.example" ".env" >nul
)
echo.

:: Criar pasta de distribuição
echo [4/5] Preparando para empacotamento...
if exist "dist" (
    echo Removendo pasta dist anterior...
    rmdir /s /q dist
)

:: Empacotar aplicação
echo [5/5] Empacotando aplicacao...
call npm run package-win
if %errorlevel% neq 0 (
    echo ERRO: Falha ao empacotar aplicacao!
    echo Verifique se o electron-builder esta instalado.
    pause
    exit /b 1
)

echo.
echo ========================================
echo    Empacotamento concluido!
echo ========================================
echo.
echo O executavel foi criado na pasta: dist/
echo.
echo Para distribuir:
echo 1. Vá para a pasta dist/
echo 2. Execute o instalador .exe
echo 3. Siga as instrucoes de instalacao
echo.
echo A aplicacao sera instalada como um programa desktop
echo e aparecera no menu Iniciar e na area de trabalho.
echo.
echo Pressione qualquer tecla para continuar...
pause >nul 