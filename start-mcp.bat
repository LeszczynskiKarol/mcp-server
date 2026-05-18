@echo off
cd /d C:\Users\Admin\frp\frp_0.61.1_windows_amd64
start "FRP tunnel mcp" /min frpc.exe -c frpc-mcp.toml

cd /d D:\mcp-server
start "MCP server" /min cmd /k "node server.js"