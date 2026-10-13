@echo off
rem Star Glass bridge on the Windows PC running N.I.N.A. - restart loop, started hidden at log-on.
rem Copy to %LOCALAPPDATA%\quiet-hub\star-bridge-loop.cmd and adjust the two paths and your login.
cd /d C:\path\to\quietglass-g2\apps\star-glass
set PORT=8893
set HOST=127.0.0.1
set STAR_NINA=http://127.0.0.1:1888
set STAR_TAILSCALE_USERS=you@example.com
:loop
"C:\Program Files\nodejs\node.exe" examples\star-bridge.mjs >> "%LOCALAPPDATA%\quiet-hub\star-bridge.log" 2>&1
timeout /t 10 /nobreak > nul
goto loop
