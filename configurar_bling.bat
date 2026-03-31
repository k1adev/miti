@echo off
echo ========================================
echo    CONFIGURACAO DA INTEGRACAO BLING
echo ========================================
echo.

echo Verificando configuracoes...
echo.

REM Verificar se o arquivo .env existe
if not exist ".env" (
    echo [ERRO] Arquivo .env nao encontrado!
    echo.
    echo Crie o arquivo .env baseado no env.example:
    echo copy env.example .env
    echo.
    pause
    exit /b 1
)

echo [OK] Arquivo .env encontrado
echo.

REM Verificar se as variáveis do Bling estão configuradas
findstr /C:"BLING_CLIENT_ID" .env >nul
if %errorlevel% neq 0 (
    echo [AVISO] BLING_CLIENT_ID nao configurado
) else (
    echo [OK] BLING_CLIENT_ID configurado
)

findstr /C:"BLING_CLIENT_SECRET" .env >nul
if %errorlevel% neq 0 (
    echo [AVISO] BLING_CLIENT_SECRET nao configurado
) else (
    echo [OK] BLING_CLIENT_SECRET configurado
)

echo.
echo ========================================
echo    INSTRUCOES DE CONFIGURACAO
echo ========================================
echo.
echo 1. Acesse: https://www.bling.com.br/central-extensoes
echo 2. Clique em "Area do Integrador"
echo 3. Clique em "CRIAR NOVO APLICATIVO"
echo 4. Configure:
echo    - Visibilidade: Privado
echo    - Nome: Apoli Sistema de Gestao
echo    - Categoria: Gestao de estoques
echo    - Link de redirecionamento: http://localhost:3000/api/bling/callback
echo    - Escopos: notasfiscais.read
echo.
echo 5. Copie o CLIENT_ID e CLIENT_SECRET
echo 6. Edite o arquivo .env e configure:
echo    BLING_CLIENT_ID=seu_client_id_aqui
echo    BLING_CLIENT_SECRET=seu_client_secret_aqui
echo.
echo 7. Execute: start.bat
echo 8. Acesse: http://localhost:3001
echo 9. Vá para "Pedidos" e clique em "Autorizar Bling"
echo.
echo ========================================
echo    DOCUMENTACAO COMPLETA
echo ========================================
echo.
echo Para mais detalhes, consulte o arquivo:
echo INTEGRACAO_BLING.md
echo.
pause 