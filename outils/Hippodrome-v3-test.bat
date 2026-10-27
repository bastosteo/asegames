@echo off
chcp 65001 >nul
title ASE Vegas - Hippodrome v3 (site de test)
echo.
echo  =============================================
echo   ASE Hippodrome v3 (chevaux des joueurs) : SITE DE TEST
echo   https://asevegas-test.pages.dev/hippodrome/
echo  =============================================
echo.
set "Z="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "(Get-ChildItem -Path ([Environment]::GetFolderPath('UserProfile') + '\Downloads') -Recurse -Filter 'loto-ase*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName"`) do set "Z=%%F"
if not defined Z (
  echo  ERREUR : aucun fichier loto-ase-hippodrome.zip trouve dans tes Telechargements.
  echo  Telecharge-le depuis la conversation avec Claude, puis relance.
  goto fin_erreur
)
echo  Zip utilise : %Z%
for /f "usebackq delims=" %%P in (`wsl -e wslpath -a "%Z%"`) do set "ZW=%%P"
wsl -e unzip -oq "%ZW%" -d /home/bastos
if errorlevel 1 (
  echo  ERREUR : impossible de decompresser le zip.
  goto fin_erreur
)
wsl -e bash /home/bastos/loto-ase/outils/deployer-hippodrome3-test.sh
if errorlevel 1 goto fin_erreur
echo.
echo  TERMINE ! Hippodrome v3 en ligne sur le site de test :
echo  https://asevegas-test.pages.dev/hippodrome/
echo.
pause
exit /b 0
:fin_erreur
echo.
echo  Une erreur s'est produite. Copie le texte de cette fenetre et envoie-le a Claude.
echo.
pause
exit /b 1
