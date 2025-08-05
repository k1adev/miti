@echo off
echo ========================================
echo    CORRIGINDO PROBLEMAS DO GIT
echo ========================================
echo.

echo [1/6] Verificando Git...
git --version >nul 2>&1
if errorlevel 1 (
    echo ERRO: Git nao encontrado. Instale o Git primeiro.
    echo Download: https://git-scm.com/downloads
    pause
    exit /b 1
)
echo Git encontrado!

echo.
echo [2/6] Inicializando repositorio Git...
if exist ".git" (
    echo Repositorio Git ja existe.
) else (
    git init
    echo Repositorio Git inicializado.
)

echo.
echo [3/6] Removendo remote origin existente (se houver)...
git remote remove origin 2>nul
echo Remote origin removido.

echo.
echo [4/6] Adicionando arquivos ao staging...
git add .
if errorlevel 1 (
    echo ERRO: Falha ao adicionar arquivos
    pause
    exit /b 1
)
echo Arquivos adicionados com sucesso!

echo.
echo [5/6] Fazendo commit inicial...
git commit -m "feat: sistema de gestao empresarial completo - Apoli v2.0"
if errorlevel 1 (
    echo ERRO: Falha ao fazer commit
    pause
    exit /b 1
)
echo Commit realizado com sucesso!

echo.
echo [6/6] Verificando branch atual...
git branch
echo.
echo ========================================
echo    PROBLEMAS RESOLVIDOS!
echo ========================================
echo.
echo Agora voce pode:
echo.
echo 1. Criar repositorio no GitHub:
echo    - Vá para: https://github.com/new
echo    - Nome: apoli-sistema-gestao
echo    - Marque "Private"
echo    - NÃO inicialize com README
echo.
echo 2. Conectar ao repositorio:
echo    git remote add origin https://github.com/SEU-USUARIO/apoli-sistema-gestao.git
echo.
echo 3. Enviar codigo:
echo    git push -u origin main
echo.
echo ========================================
pause 