@echo off
cd /d D:\mcp-server
if not exist logs mkdir logs
:loop
rem Rotate log if over 20 MB. Safe only here: the >> handle is released
rem between loop iterations, so rotation happens on every respawn/restart.
if exist logs\mcp.log for %%F in (logs\mcp.log) do if %%~zF GTR 20971520 (
  if exist logs\mcp.log.1 move /y logs\mcp.log.1 logs\mcp.log.2 >nul
  move /y logs\mcp.log logs\mcp.log.1 >nul
)
node server.js >> logs\mcp.log 2>&1
echo [%date% %time%] node exited, restarting in 5s >> logs\mcp.log
timeout /t 5 /nobreak >nul
goto loop