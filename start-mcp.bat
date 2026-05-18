@echo off
cd /d D:\mcp-server
if not exist logs mkdir logs
node server.js >> logs\mcp.log 2>&1
