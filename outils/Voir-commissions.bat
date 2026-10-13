@echo off
chcp 65001 >nul
title ASE Vegas - commissions envoyees
echo.
echo  =============================================
echo   ASE Vegas : ce que chaque jeu a envoye, et a qui
echo  =============================================
echo   Lecture seule : aucune transaction.
echo.
set "Z="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "(Get-ChildItem -Path ([Environment]::GetFolderPath('UserProfile') + '\Downloads') -Recurse -Filter 'loto-ase*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName"`) do set "Z=%%F"
if not defined Z goto lancer
echo  Zip utilise : %Z%
for /f "usebackq delims=" %%P in (`wsl -e wslpath -a "%Z%"`) do set "ZW=%%P"
wsl -e unzip -oq "%ZW%" "loto-ase/outils/commissions.mjs" -d /home/bastos
:lancer
wsl -e bash -lc "export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH; cd ~/loto-ase && node outils/commissions.mjs 2>&1 | grep -v -e Warning -e Reparsing -e trace-warnings -e 'type.: .module'"
echo.
pause
