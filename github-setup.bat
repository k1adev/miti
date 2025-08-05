@echo off
echo ========================================
echo    CONFIGURACAO GITHUB - APOLI
echo ========================================
echo.

echo [1/5] Verificando Git...
git --version >nul 2>&1
if errorlevel 1 (
    echo ERRO: Git nao encontrado. Instale o Git primeiro.
    echo Download: https://git-scm.com/downloads
    pause
    exit /b 1
)

echo.
echo [2/5] Inicializando repositorio Git...
if exist ".git" (
    echo Repositorio Git ja existe.
) else (
    git init
    echo Repositorio Git inicializado.
)

echo.
echo [3/5] Adicionando arquivos...
git add .
if errorlevel 1 (
    echo ERRO: Falha ao adicionar arquivos
    pause
    exit /b 1
)

echo.
echo [4/5] Fazendo commit inicial...
git commit -m "feat: sistema de gestao empresarial completo - Apoli v2.0"
if errorlevel 1 (
    echo ERRO: Falha ao fazer commit
    pause
    exit /b 1
)

echo.
echo [5/5] Configuracao concluida!
echo.
echo ========================================
echo    PROXIMOS PASSOS:
echo ========================================
echo.
echo 1. Crie um repositorio PRIVADO no GitHub:
echo    - Vá para: https://github.com/new
echo    - Nome: apoli-sistema-gestao
echo    - Marque "Private"
echo    - NÃO inicialize com README
echo.
echo 2. Conecte o repositorio local:
echo    git remote add origin https://github.com/SEU-USUARIO/apoli-sistema-gestao.git
echo.
echo 3. Envie o codigo:
echo    git push -u origin main
echo.
echo 4. Configure a demo online:
echo    - Execute: deploy.bat
echo    - Ou use: npm i -g vercel && vercel
echo.
echo 5. Atualize o README com o link da demo
echo.
echo ========================================
echo    DICAS DE PROTECAO:
echo ========================================
echo.
echo ✅ Repositorio privado = Protecao maxima
echo ✅ Demo online = Visualizacao publica
echo ✅ README profissional = Portfolio atrativo
echo ✅ Screenshots = Demonstracao visual
echo.
pause 