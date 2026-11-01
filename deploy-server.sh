#!/bin/bash

# Reddit MCP Buddy Server Deployment Script
# Supports both local and Docker deployment

set -e  # Exit on error

# Default configuration
DEFAULT_PORT=35000
PORT=$DEFAULT_PORT
DEPLOYMENT_MODE="local"  # Default to local deployment
TERMINATE_ONLY=false
CONTAINER_NAME="reddit-mcp-buddy"
IMAGE_NAME="reddit-mcp-buddy"
SERVER_PID_FILE=".server.pid"
SERVER_PORT_FILE=".server.port"

# Function to show usage
show_help() {
    echo "Reddit MCP Buddy Server Deployment Script"
    echo ""
    echo "This script can deploy the server locally (default) or in Docker."
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -m, --mode MODE      Deployment mode: 'local' (default) or 'docker'"
    echo "  -p, --port PORT      Port to expose (default: $DEFAULT_PORT)"
    echo "  -t, --terminate      Terminate existing server/container and exit"
    echo "  -h, --help           Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                   # Deploy locally on default port $DEFAULT_PORT"
    echo "  $0 --mode docker     # Deploy using Docker"
    echo "  $0 --port 36000      # Deploy locally on custom port"
    echo "  $0 -m docker -p 8080 # Deploy in Docker on port 8080"
    echo "  $0 --terminate       # Stop existing server/container"
    echo ""
    echo "Note: Local deployment is recommended due to better network compatibility."
    echo "      Docker deployment may have issues accessing external APIs."
    exit 0
}

# Function to terminate local server
terminate_local_server() {
    # Kill any existing Node.js processes running the server
    echo "🔍 Looking for existing local server..."

    # First, try to use the PID file (most reliable)
    if [ -f "$SERVER_PID_FILE" ]; then
        OLD_PID=$(cat "$SERVER_PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            # Also read the port from the port file if it exists
            if [ -f "$SERVER_PORT_FILE" ]; then
                OLD_PORT=$(cat "$SERVER_PORT_FILE")
                echo "🛑 Stopping server with PID $OLD_PID on port $OLD_PORT..."
            else
                echo "🛑 Stopping server with PID $OLD_PID..."
            fi
            kill "$OLD_PID" 2>/dev/null || true
            sleep 1
            # Force kill if still running
            kill -9 "$OLD_PID" 2>/dev/null || true
            echo "✅ Server stopped"
        else
            echo "ℹ️  Server PID $OLD_PID is no longer running"
        fi
        rm -f "$SERVER_PID_FILE"
        rm -f "$SERVER_PORT_FILE"
    else
        echo "ℹ️  No PID file found, server may not be running"
    fi

    # Only check port if we're NOT in terminate-only mode
    # This prevents killing MCP clients that might be connecting to the port
    if [ "$TERMINATE_ONLY" != true ]; then
        # Check if something is LISTENING on the port (not just connected to it)
        PORT_PID=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null || true)
        if [ -n "$PORT_PID" ]; then
            echo "⚠️  Warning: Another process (PID: $PORT_PID) is listening on port $PORT"
            echo "   This might be another instance of the server not tracked by PID file"
            # Get process info to help user decide
            PROC_INFO=$(ps -p $PORT_PID -o comm= 2>/dev/null || echo "unknown")
            echo "   Process: $PROC_INFO"
            if [[ "$PROC_INFO" == *"node"* ]] || [[ "$PROC_INFO" == *"npm"* ]]; then
                echo "   This appears to be a Node.js process, stopping it..."
                kill $PORT_PID 2>/dev/null || true
                sleep 1
                kill -9 $PORT_PID 2>/dev/null || true
                echo "✅ Port $PORT cleared"
            else
                echo "   Not a Node.js process, leaving it alone"
                echo "   Please use --port to choose a different port"
                exit 1
            fi
        fi
    fi
}

# Function to terminate Docker container
terminate_docker_container() {
    # Find container running Reddit MCP Buddy
    EXISTING_CONTAINER=$(docker ps -a --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | head -n1)

    if [ -n "$EXISTING_CONTAINER" ]; then
        echo "🛑 Found existing Docker container: $EXISTING_CONTAINER"

        # Get the port it's using
        EXISTING_PORT=$(docker port $EXISTING_CONTAINER 3000/tcp 2>/dev/null | cut -d: -f2 || echo "unknown")
        echo "   Running on port: $EXISTING_PORT"

        echo "   Stopping and removing..."
        docker stop $EXISTING_CONTAINER 2>/dev/null || true
        docker rm $EXISTING_CONTAINER 2>/dev/null || true
        echo "✅ Docker container terminated"
    else
        echo "ℹ️  No existing Docker container found"
    fi
}

# Function to deploy locally
deploy_local() {
    echo "📍 Local deployment on port: $PORT"

    # Check if port is available
    if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "❌ Port $PORT is already in use!"
        echo "   Please choose a different port with --port option"
        exit 1
    fi

    # Build the project
    echo "🔨 Building TypeScript..."
    npm run build

    # Start the server in background
    echo "🏃 Starting server locally..."
    REDDIT_BUDDY_HTTP=true REDDIT_BUDDY_PORT=$PORT npm start &
    SERVER_PID=$!

    # Save PID and port for future termination
    echo $SERVER_PID > "$SERVER_PID_FILE"
    echo $PORT > "$SERVER_PORT_FILE"

    # Wait for server to be ready
    echo "⏳ Waiting for server to be ready..."
    RETRIES=30
    while [ $RETRIES -gt 0 ]; do
        if curl -s http://localhost:$PORT/health >/dev/null 2>&1; then
            echo "✅ Server is ready!"
            break
        fi
        sleep 1
        RETRIES=$((RETRIES - 1))
        echo -n "."
    done
    echo ""

    if [ $RETRIES -eq 0 ]; then
        echo "⚠️  Server failed to start properly"
        exit 1
    fi

    echo ""
    echo "✅ Local deployment successful!"
    echo "======================================"
    echo "🌐 Reddit MCP Buddy is running at: http://localhost:$PORT"
    echo "📡 MCP endpoint: http://localhost:$PORT/mcp"
    echo "🔌 Connect with Postman MCP or Claude Desktop"
    echo ""
    echo "📝 Server PID: $SERVER_PID (saved to $SERVER_PID_FILE)"
    echo ""
    echo "💡 To stop the server:"
    echo "   $0 --terminate"
    echo "   or: kill $SERVER_PID"
}

# Function to deploy with Docker
deploy_docker() {
    echo "📍 Docker deployment on port: $PORT"

    # Check if port is available
    if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "❌ Port $PORT is already in use!"
        echo "   Please choose a different port with --port option"
        exit 1
    fi

    # Save port for reference
    echo $PORT > .docker-port

    # Build the Docker image
    echo "🔨 Building Docker image..."
    docker build -t $IMAGE_NAME .

    # Run the container
    echo "🏃 Starting Docker container..."
    docker run -d \
        --name $CONTAINER_NAME \
        -p 127.0.0.1:$PORT:3000 \
        -e REDDIT_BUDDY_HTTP=true \
        --restart unless-stopped \
        --health-cmd="node -e \"fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))\"" \
        --health-interval=30s \
        --health-timeout=10s \
        --health-retries=3 \
        $IMAGE_NAME

    # Wait for container to be healthy
    echo "⏳ Waiting for container to be healthy..."
    RETRIES=30
    while [ $RETRIES -gt 0 ]; do
        if docker ps | grep -q "(healthy).*$CONTAINER_NAME"; then
            echo "✅ Container is healthy!"
            break
        fi
        sleep 2
        RETRIES=$((RETRIES - 1))
        echo -n "."
    done

    if [ $RETRIES -eq 0 ]; then
        echo "⚠️  Container failed to become healthy"
        echo "📋 Container logs:"
        docker logs $CONTAINER_NAME
        exit 1
    fi

    echo ""
    echo "✅ Docker deployment successful!"
    echo "======================================"
    echo "🌐 Reddit MCP Buddy is running at: http://localhost:$PORT"
    echo "📊 Container status:"
    docker ps | grep $CONTAINER_NAME
    echo ""
    echo "📝 Useful Docker commands:"
    echo "  View logs:    docker logs -f $CONTAINER_NAME"
    echo "  Stop:         docker stop $CONTAINER_NAME"
    echo "  Restart:      docker restart $CONTAINER_NAME"
    echo "  Remove:       docker rm -f $CONTAINER_NAME"
    echo ""
    echo "⚠️  Note: Docker deployment may have network issues accessing Reddit API."
    echo "    If you encounter 'Network error', use local deployment instead."
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--mode)
            DEPLOYMENT_MODE="$2"
            if [[ "$DEPLOYMENT_MODE" != "local" && "$DEPLOYMENT_MODE" != "docker" ]]; then
                echo "❌ Invalid mode: $DEPLOYMENT_MODE"
                echo "   Mode must be 'local' or 'docker'"
                exit 1
            fi
            shift 2
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        -t|--terminate)
            TERMINATE_ONLY=true
            shift
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

echo "🚀 Reddit MCP Buddy Server Deployment"
echo "======================================"

# Terminate existing deployment based on mode
if [ "$DEPLOYMENT_MODE" = "docker" ] || [ "$TERMINATE_ONLY" = true ]; then
    terminate_docker_container
fi

if [ "$DEPLOYMENT_MODE" = "local" ] || [ "$TERMINATE_ONLY" = true ]; then
    terminate_local_server
fi

# If terminate-only mode, exit here
if [ "$TERMINATE_ONLY" = true ]; then
    echo "======================================"
    echo "✅ Termination complete"
    exit 0
fi

# Deploy based on mode
if [ "$DEPLOYMENT_MODE" = "local" ]; then
    deploy_local
elif [ "$DEPLOYMENT_MODE" = "docker" ]; then
    deploy_docker
fi