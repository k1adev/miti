@echo off
setlocal enabledelayedexpansion

echo ========================================
echo    Atualizador do Apoli - Sistema de Gestao
echo ========================================
echo.

:: Verificar se está no diretório correto
if not exist "package.json" (
    echo ERRO: Execute este script na pasta raiz do projeto!
    pause
    exit /b 1
)

:: Fazer backup do banco de dados
echo [1/6] Fazendo backup do banco de dados...
if exist "database.sqlite" (
    echo Criando backup do banco de dados...
    copy "database.sqlite" "database_backup_%date:~-4,4%%date:~-10,2%%date:~-7,2%_%time:~0,2%%time:~3,2%%time:~6,2%.sqlite" >nul
    echo Backup criado com sucesso!
) else (
    echo Nenhum banco de dados encontrado para backup.
)
echo.

:: Parar servidores em execução
echo [2/6] Parando servidores em execucao...
taskkill /f /im node.exe >nul 2>&1
timeout /t 3 /nobreak >nul
echo Servidores parados.
echo.

:: Fazer backup do arquivo .env
echo [3/6] Fazendo backup das configuracoes...
if exist ".env" (
    copy ".env" ".env_backup" >nul
    echo Configuracoes salvas.
) else (
    echo Nenhum arquivo .env encontrado.
)
echo.

:: Atualizar dependências do backend
echo [4/6] Atualizando dependencias do backend...
call npm update
if %errorlevel% neq 0 (
    echo ERRO: Falha ao atualizar dependencias do backend!
    echo Tentando reinstalar...
    call npm install
    if %errorlevel% neq 0 (
        echo ERRO: Falha ao reinstalar dependencias do backend!
        pause
        exit /b 1
    )
)
echo Dependencias do backend atualizadas com sucesso!
echo.

:: Atualizar dependências do frontend
echo [5/6] Atualizando dependencias do frontend...
cd client
call npm update
if %errorlevel% neq 0 (
    echo ERRO: Falha ao atualizar dependencias do frontend!
    echo Tentando reinstalar...
    call npm install
    if %errorlevel% neq 0 (
        echo ERRO: Falha ao reinstalar dependencias do frontend!
        cd ..
        pause
        exit /b 1
    )
)
cd ..
echo Dependencias do frontend atualizadas com sucesso!
echo.

:: Reconstruir aplicação
echo [6/6] Reconstruindo aplicacao...
cd client
call npm run build
if %errorlevel% neq 0 (
    echo ERRO: Falha ao construir aplicacao!
    cd ..
    pause
    exit /b 1
)
cd ..
echo Aplicacao reconstruida com sucesso!
echo.

echo ========================================
echo    Atualizacao concluida com sucesso!
echo ========================================
echo.
echo Para reiniciar a aplicacao:
echo.
echo Opcao 1 - Desenvolvimento:
echo   npm run dev
echo.
echo Opcao 2 - Producao:
echo   npm start
echo.
echo Opcao 3 - Com Electron:
echo   npm run electron
echo.
echo Opcao 4 - Usar script de inicializacao:
echo   start.bat
echo.
echo A aplicacao estara disponivel em:
echo - Local: http://localhost:3001
echo - Rede: http://[SEU_IP]:3001
echo.
echo Pressione qualquer tecla para continuar...
pause >nul 