@echo off
echo ========================================
echo    DEPLOY FINAL - APOLI GITHUB
echo ========================================
echo.

echo [1/4] Verificando status do Git...
git status
echo.

echo [2/4] Verificando branch atual...
git branch
echo.

echo [3/4] Verificando remote...
git remote -v
echo.

echo [4/4] INSTRUCOES FINAIS:
echo.
echo ========================================
echo    1. CRIE O REPOSITORIO NO GITHUB:
echo ========================================
echo.
echo - Vá para: https://github.com/new
echo - Nome: apoli-sistema-gestao
echo - Descrição: Sistema de Gestão Empresarial completo
echo - Marque: PRIVATE
echo - NÃO inicialize com README
echo.
echo ========================================
echo    2. CONECTE AO REPOSITORIO:
echo ========================================
echo.
echo Execute este comando (substitua SEU-USUARIO):
echo.
echo git remote add origin https://github.com/SEU-USUARIO/apoli-sistema-gestao.git
echo.
echo ========================================
echo    3. ENVIE O CODIGO:
echo ========================================
echo.
echo Execute este comando:
echo.
echo git push -u origin main
echo.
echo ========================================
echo    4. CONFIGURE A DEMO:
echo ========================================
echo.
echo Execute: .\deploy.bat
echo.
echo ========================================
pause 