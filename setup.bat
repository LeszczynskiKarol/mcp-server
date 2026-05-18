@echo off
echo === MCP Server setup ===
if not exist .env (
    copy .env.example .env
    echo Created .env from .env.example - edit it and fill in MCP_PASS, MCP_BASE_URL
) else (
    echo .env already exists, skipping
)
if not exist hosts.json (
    copy hosts.example.json hosts.json
    echo Created hosts.json from hosts.example.json - edit it and add your servers
) else (
    echo hosts.json already exists, skipping
)
echo === Installing dependencies ===
call npm install
echo === Done ===
echo Edit .env and hosts.json, then run: node server.js