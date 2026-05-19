@echo off
cd /d D:\mcp-server
if not exist logs mkdir logs
:loop
node server.js >> logs\mcp.log 2>&1
echo [%date% %time%] node exited, restarting in 5s >> logs\mcp.log
timeout /t 5 /nobreak >nul
goto loop