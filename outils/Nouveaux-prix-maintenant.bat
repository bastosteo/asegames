@echo off
chcp 65001 >nul
title ASE Vegas - nouveaux prix maintenant
echo.
echo  =============================================
echo   Nouveaux prix tout de suite : Loto 1 ASE, Raffle 2 ASE, Treasure 0.2 ASE
echo  =============================================
echo.
set "Z="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "(Get-ChildItem -Path ([Environment]::GetFolderPath('UserProfile') + '\Downloads') -Recurse -Filter 'loto-ase*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName"`) do set "Z=%%F"
if not defined Z (
  echo  ERREUR : aucun fichier loto-ase.zip trouve dans tes Telechargements.
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
wsl -e bash /home/bastos/loto-ase/outils/tout-nouveau.sh
if errorlevel 3 goto plus_tard
if errorlevel 1 goto fin_erreur
echo.
echo  TERMINE ! Nouveaux contrats en ligne, joueurs rembourses.
echo  Site : https://asevegas.pages.dev/
echo.
pause
exit /b 0
:plus_tard
echo.
echo  Pas encore possible : un tirage (ou un tresor) est en cours.
echo  Relance ce meme fichier plus tard : apres 21h00 pour le Loto (rien n'a ete envoye).
echo.
pause
exit /b 0
:fin_erreur
echo.
echo  Une erreur s'est produite. Copie le texte de cette fenetre et envoie-le a Claude.
echo.
pause
exit /b 1
