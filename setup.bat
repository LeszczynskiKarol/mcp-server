@echo off
echo === MCP Server setup ===
if not exist .env (
    copy .env.example .env
    echo Utworzono .env z .env.example - edytuj i wypelnij MCP_PASS, MCP_BASE_URL
) else (
    echo .env juz istnieje, pomijam
)
if not exist hosts.json (
    copy hosts.example.json hosts.json
    echo Utworzono hosts.json z hosts.example.json - edytuj i dodaj swoje serwery
) else (
    echo hosts.json juz istnieje, pomijam
)
echo === Instaluje zaleznosci ===
call npm install
echo === Gotowe ===
echo Edytuj .env i hosts.json, potem uruchom: node server.js