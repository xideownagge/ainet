@echo off
REM Бесплатный туннель Cloudflare к локальному AINET. Адрес случайный и живёт, пока открыто это окно.
REM После запуска скопируйте адрес https://....trycloudflare.com в .env (PUBLIC_URL=...) и перезапустите npm start.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate
