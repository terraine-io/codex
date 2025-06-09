#!/bin/bash

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
echo "Building WebSocket server..."
node build-ws-server.mjs

