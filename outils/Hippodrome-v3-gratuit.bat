@echo off
chcp 65001 >nul
title ASE Vegas - Hippodrome v3 gratuit (site de test)
echo.
echo  =============================================
echo   Hippodrome v3 (SITE DE TEST) : chevaux gratuits
echo   Prix des chevaux, nourrir, entrainer, inscription : 0 ASE
echo  =============================================
echo.
wsl -e bash /home/bastos/loto-ase/outils/hippo3-gratuit-test.sh
if errorlevel 1 goto fin_erreur
echo.
echo  TERMINE ! Sur le site de test, tout est gratuit dans l'Ecurie :
echo  https://asevegas-test.pages.dev/hippodrome/
echo.
pause
exit /b 0
:fin_erreur
echo.
echo  Arrete (tu as repondu n) ou une erreur s'est produite.
echo  En cas d'erreur, copie le texte de cette fenetre et envoie-le a Claude.
echo.
pause
exit /b 1
