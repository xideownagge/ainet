@echo off
REM AINET: сервер + бесплатный туннель Cloudflare. Адрес туннеля сам публикуется на GitHub (файл SERVER_URL).
REM Держите окно открытым. После перезагрузки компьютера просто запустите этот файл снова.
cd /d "%~dp0"
node scripts\up.mjs
pause
