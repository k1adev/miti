@echo off
setlocal enabledelayedexpansion

echo ========================================
echo    Iniciando Apoli - Sistema de Gestao
echo ========================================
echo.

:: Verificar se as dependências estão instaladas
if not exist "node_modules" (
    echo ERRO: Dependencias nao encontradas!
    echo Execute primeiro: install.bat
    pause
    exit /b 1
)

if not exist "client\node_modules" (
    echo ERRO: Dependencias do frontend nao encontradas!
    echo Execute primeiro: install.bat
    pause
    exit /b 1
)

:: Verificar se o arquivo .env existe
if not exist ".env" (
    echo AVISO: Arquivo .env nao encontrado!
    echo Criando arquivo de configuracao padrao...
    copy "env.example" ".env" >nul
)

:: Parar processos Node.js em execução
echo Parando processos Node.js em execucao...
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Iniciar servidor backend
echo Iniciando servidor backend...
start "Apoli Backend" cmd /k "echo Iniciando servidor backend... && npm start"

:: Aguardar o servidor backend inicializar
echo Aguardando servidor backend inicializar...
timeout /t 5 /nobreak >nul

:: Verificar se o servidor está rodando
echo Verificando se o servidor esta rodando...
curl -s http://localhost:3001/api/status >nul 2>&1
if %errorlevel% neq 0 (
    echo AVISO: Servidor backend pode nao estar rodando ainda.
    echo Aguardando mais alguns segundos...
timeout /t 3 /nobreak >nul
)

:: Iniciar servidor frontend (opcional para desenvolvimento)
echo.
echo Deseja iniciar o servidor frontend para desenvolvimento? (S/N)
set /p choice="Digite S para sim ou N para nao: "

if /i "!choice!"=="S" (
echo Iniciando servidor frontend...
    start "Apoli Frontend" cmd /k "echo Iniciando servidor frontend... && cd client && npm start"
    echo.
    echo ========================================
    echo    Modo Desenvolvimento Ativado!
    echo ========================================
    echo.
    echo Aplicacao disponivel em:
    echo - Frontend: http://localhost:3000
    echo - Backend:  http://localhost:3001
    echo.
) else (
echo.
echo ========================================
    echo    Modo Producao Ativado!
echo ========================================
echo.
    echo Aplicacao disponivel em:
    echo - Local: http://localhost:3001
echo - Rede: http://[SEU_IP]:3001
    echo.
)

echo Para acessar na rede local:
echo 1. Descubra seu IP: ipconfig
echo 2. Acesse: http://[SEU_IP]:3001
echo.
echo Para parar os servidores, feche as janelas ou execute:
echo taskkill /f /im node.exe
echo.
echo Pressione qualquer tecla para fechar esta janela...
pause >nul 