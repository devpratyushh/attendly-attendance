#!/bin/bash
# Face Recognition Attendance System Launcher

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"

function start_backend() {
    echo "Starting backend server on http://localhost:8000..."
    cd "$DIR/backend"
    "$DIR/backend/venv/bin/uvicorn" main:app --host 0.0.0.0 --port 8000 --reload
}

function start_frontend() {
    echo "Starting frontend dev server on http://localhost:3000..."
    cd "$DIR/frontend"
    npm run dev
}

if [ "$1" == "backend" ]; then
    start_backend
elif [ "$1" == "frontend" ]; then
    start_frontend
else
    echo "Starting both backend and frontend..."
    cd "$DIR/backend"
    "$DIR/backend/venv/bin/uvicorn" main:app --host 0.0.0.0 --port 8000 --reload &
    BACKEND_PID=$!

    cd "$DIR/frontend"
    npm run dev &
    FRONTEND_PID=$!

    trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
    wait
fi
