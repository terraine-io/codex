#!/bin/bash

# Script to run the WebSocket AgentLoop server

echo "Starting WebSocket AgentLoop Server..."

# Check if OPENAI_API_KEY is set
if [ -z "$OPENAI_API_KEY" ]; then
    echo "Warning: OPENAI_API_KEY environment variable is not set."
    echo "Please set it with: export OPENAI_API_KEY='your-api-key-here'"
    echo ""
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed or not in PATH"
    exit 1
fi

# Check if ts-node is available
if ! command -v npx &> /dev/null; then
    echo "Error: npx is not available"
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Build the WebSocket server if needed
if [ ! -f "dist/ws-server.js" ] || [ "ws-server.ts" -nt "dist/ws-server.js" ]; then
    echo "Building WebSocket server..."
    node build-ws-server.mjs
fi

echo "Starting server on port 8080..."
echo "Press Ctrl+C to stop the server"
echo ""

# Run the built server
node dist/ws-server.js