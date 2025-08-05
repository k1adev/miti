@echo off
setlocal enabledelayedexpansion

echo ========================================
echo    Limpeza do Apoli - Sistema de Gestao
echo ========================================
echo.

:: Verificar se está no diretório correto
if not exist "package.json" (
    echo ERRO: Execute este script na pasta raiz do projeto!
    pause
    exit /b 1
)

echo ATENCAO: Este script ira remover:
echo - node_modules (dependencias)
echo - client/node_modules (dependencias do frontend)
echo - client/build (build do frontend)
echo - dist (executaveis empacotados)
echo - uploads (arquivos enviados)
echo - logs (arquivos de log)
echo.
echo Deseja continuar? (S/N)
set /p choice="Digite S para sim ou N para nao: "

if /i not "!choice!"=="S" (
    echo Operacao cancelada.
    pause
    exit /b 0
)

:: Parar servidores em execução
echo.
echo Parando servidores em execucao...
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Remover pastas
echo Removendo node_modules do backend...
if exist "node_modules" (
    rmdir /s /q node_modules
    echo Removido.
) else (
    echo Nao encontrado.
)

echo Removendo node_modules do frontend...
if exist "client\node_modules" (
    rmdir /s /q client\node_modules
    echo Removido.
) else (
    echo Nao encontrado.
)

echo Removendo build do frontend...
if exist "client\build" (
    rmdir /s /q client\build
    echo Removido.
) else (
    echo Nao encontrado.
)

echo Removendo executaveis empacotados...
if exist "dist" (
    rmdir /s /q dist
    echo Removido.
) else (
    echo Nao encontrado.
)

echo Removendo arquivos de upload...
if exist "uploads" (
    rmdir /s /q uploads
    echo Removido.
) else (
    echo Nao encontrado.
)

echo Removendo arquivos de log...
if exist "logs" (
    rmdir /s /q logs
    echo Removido.
) else (
    echo Nao encontrado.
)

echo.
echo ========================================
echo    Limpeza concluida com sucesso!
echo ========================================
echo.
echo Para reinstalar a aplicacao:
echo 1. Execute: install.bat
echo.
echo Para iniciar a aplicacao:
echo 1. Execute: start.bat
echo.
echo Pressione qualquer tecla para continuar...
pause >nul 