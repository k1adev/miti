@echo off
echo ========================================
echo    RESET COMPLETO - GIT E GITHUB
echo ========================================
echo.

echo [1/6] Removendo repositorio Git local...
if exist ".git" (
    rmdir /s /q .git
    echo Repositorio Git local removido.
) else (
    echo Nenhum repositorio Git encontrado.
)

echo.
echo [2/6] Removendo arquivos temporarios...
if exist "node_modules" (
    rmdir /s /q node_modules
    echo node_modules removido.
)
if exist "client/node_modules" (
    rmdir /s /q client/node_modules
    echo client/node_modules removido.
)
if exist "client/build" (
    rmdir /s /q client/build
    echo client/build removido.
)

echo.
echo [3/6] Inicializando novo repositorio Git...
git init
echo Repositorio Git inicializado.

echo.
echo [4/6] Configurando branch main...
git checkout -b main
echo Branch main configurada.

echo.
echo [5/6] Adicionando arquivos...
git add .
if errorlevel 1 (
    echo ERRO: Falha ao adicionar arquivos
    pause
    exit /b 1
)
echo Arquivos adicionados com sucesso!

echo.
echo [6/6] Fazendo commit inicial...
git commit -m "Miti v1.8"
if errorlevel 1 (
    echo ERRO: Falha ao fazer commit
    pause
    exit /b 1
)
echo Commit realizado com sucesso!

echo.
echo ========================================
echo    RESET CONCLUIDO!
echo ========================================
echo.
echo Agora voce pode:
echo.
echo 1. Conectar ao repositorio:
echo    git remote add origin https://github.com/k1adev/miti.git
echo.
echo 2. Enviar codigo:
echo    git push -u origin main
echo.
echo 3. Ou forcar push (se necessario):
echo    git push --force origin main
echo.
echo ========================================
pause 