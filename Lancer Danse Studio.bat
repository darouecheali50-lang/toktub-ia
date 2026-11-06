@echo off
chcp 65001 >nul
title Danse Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js n'est pas installe.
  echo     Installez la version LTS depuis https://nodejs.org puis relancez ce fichier.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] FFmpeg n'est pas installe ^(necessaire pour remettre la musique^).
  echo     Ouvrez PowerShell et tapez :  winget install Gyan.FFmpeg
  echo     Fermez puis relancez ce fichier.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo [i] Le fichier .env vient d'etre cree et va s'ouvrir dans le Bloc-notes.
  echo     Remplissez FAL_KEY ^(votre cle fal.ai^) et APP_ACCESS_CODE ^(un code de votre choix^),
  echo     enregistrez, fermez le Bloc-notes, puis relancez ce fichier.
  notepad ".env"
  pause
  exit /b 0
)

if not exist "node_modules" (
  echo Installation des composants ^(premiere fois seulement^)...
  call npm install
  if errorlevel 1 (
    echo [!] L'installation a echoue. Verifiez votre connexion Internet.
    pause
    exit /b 1
  )
)

echo.
echo Danse Studio demarre. Le navigateur va s'ouvrir sur http://localhost:3000
echo Gardez cette fenetre ouverte pendant l'utilisation. Fermez-la pour arreter.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
