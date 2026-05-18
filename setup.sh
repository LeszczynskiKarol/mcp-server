#!/bin/bash
echo "=== MCP Server setup ==="
[ -f .env ] || { cp .env.example .env; echo "Created .env from template - edit it"; }
[ -f hosts.json ] || { cp hosts.example.json hosts.json; echo "Created hosts.json from template - edit it"; }
npm install
echo "=== Done - edit .env and hosts.json, then: node server.js ==="