@echo off
chcp 65001 >nul
title ASE Vegas - qui a joue (a rembourser)
echo.
echo  =============================================
echo   Qui a joue le Loto, la Raffle et la carte Treasure EN COURS
echo   et combien lui rembourser
echo  =============================================
echo   Lecture seule : aucune transaction.
echo.
set "Z="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "(Get-ChildItem -Path ([Environment]::GetFolderPath('UserProfile') + '\Downloads') -Recurse -Filter 'loto-ase*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName"`) do set "Z=%%F"
if not defined Z goto lancer
echo  Zip utilise : %Z%
for /f "usebackq delims=" %%P in (`wsl -e wslpath -a "%Z%"`) do set "ZW=%%P"
wsl -e unzip -oq "%ZW%" "loto-ase/outils/rembourser.mjs" "loto-ase/outils/voir-participants.sh" -d /home/bastos
:lancer
wsl -e bash /home/bastos/loto-ase/outils/voir-participants.sh
echo.
pause
