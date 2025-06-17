#!/usr/bin/env node

import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve, extname } from 'path';
import { AgentLoopFactory } from './src/utils/agent/index.js';
import { type ClaudeTool } from './src/utils/agent/claude-types.js';
import { config } from 'dotenv';
import { initLogger, debug } from './src/utils/logger/log.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RestHandlers } from './ws-rest-handlers.js';
import { JupyterMcpWrapper } from './ws-mcp-cli.js';
import { SessionManager } from './ws-session-manager.js';


// Load environment variables and configure working directory
function initializeEnvironment() {
  // Load .env file if it exists
  config();

  // Determine which provider will be used to check for appropriate API key
  const model = process.env.MODEL || 'codex-mini-latest';
  const provider = process.env.PROVIDER || AgentLoopFactory.detectProvider(model);

  // Check for required API key based on provider
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ Error: ANTHROPIC_API_KEY environment variable is not set');
      console.error('Please set your Anthropic API key:');
      console.error('  export ANTHROPIC_API_KEY="your-api-key-here"');
      console.error('');
      console.error('You can get an API key from: https://console.anthropic.com/');
      process.exit(1);
    }
    console.log('✅ ANTHROPIC_API_KEY is set');
  } else if (provider === 'google') {
    if (!process.env.GOOGLE_API_KEY && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.error('❌ Error: GOOGLE_API_KEY or GOOGLE_APPLICATION_CREDENTIALS environment variable is not set');
      console.error('Please set your Google API key:');
      console.error('  export GOOGLE_API_KEY="your-api-key-here"');
      console.error('');
      console.error('You can get an API key from: https://makersuite.google.com/app/apikey');
      process.exit(1);
    }
    console.log('✅ Google API key is set');
  } else {
    // Default to OpenAI
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ Error: OPENAI_API_KEY environment variable is not set');
      console.error('Please set your OpenAI API key:');
      console.error('  export OPENAI_API_KEY="your-api-key-here"');
      console.error('');
      console.error('You can get an API key from: https://platform.openai.com/account/api-keys');
      process.exit(1);
    }
    console.log('✅ OPENAI_API_KEY is set');
  }

  // Configure working directory if specified
  const workingDir = process.env.WORKING_DIRECTORY;
  if (workingDir) {
    const absolutePath = resolve(workingDir);

    if (!existsSync(absolutePath)) {
      console.error(`❌ Error: Working directory does not exist: ${absolutePath}`);
      console.error('Please create the directory or update WORKING_DIRECTORY in your .env file');
      process.exit(1);
    }

    try {
      process.chdir(absolutePath);
      console.log(`✅ Changed working directory to: ${absolutePath}`);
    } catch (error) {
      console.error(`❌ Error: Failed to change to working directory: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.log(`ℹ️  Using current working directory: ${process.cwd()}`);
  }
}

// Types for artifacts
export interface ArtifactItem {
  artifact_id: string;
  file_path: string;
  overview: string;
}

export interface ArtifactsIndex {
  artifacts_root_path: string;
  artifacts: ArtifactItem[];
}

// Types for data connectors
export interface DataConnector {
  id: string;
  name: string;
  type: 'local_file' | 'gcs';
  config: {
    // Local file config
    file_path?: string; // Optional until file is uploaded
    filename?: string; // Filename to use when saving uploaded content
    file_type?: 'text' | 'csv' | 'json' | 'binary';
    encoding?: string;

    // GCS config
    gcs_url?: string; // GCS URL in format gs://bucket-name or gs://bucket-name/path/to/subroot
    local_mount_point_path?: string; // Local mount point where GCS bucket is mounted
  };
  status: 'pending_upload' | 'active' | 'inactive' | 'error';
  created_at: string;
  last_used?: string;
  metadata?: {
    file_size?: number;
    mime_type?: string;
    last_modified?: string;
  };
}

export interface SessionInfo {
  id: string;
  start_time: string;
  last_update_time: string;
  event_count: number;
}

// GCS utility functions
const execAsync = promisify(exec);

interface GCSConfig {
  bucketId: string;
  restrictToSubroot?: string;
}

export function parseGcsUrl(gcsUrl: string): GCSConfig | null {
  if (!gcsUrl.startsWith('gs://')) {
    return null;
  }

  const urlPart = gcsUrl.slice(5); // Remove 'gs://' prefix
  const parts = urlPart.split('/');

  if (parts.length === 0 || !parts[0]) {
    return null;
  }

  const bucketId = parts[0];
  const restrictToSubroot = parts.length > 1 ? parts.slice(1).join('/') : undefined;

  return {
    bucketId,
    restrictToSubroot
  };
}

export async function checkGcsfuseInstalled(): Promise<boolean> {
  try {
    await execAsync('gcsfuse -v');
    return true;
  } catch (error) {
    return false;
  }
}

export async function mountGcsBucket(config: GCSConfig, mountPoint: string): Promise<void> {
  const { bucketId, restrictToSubroot } = config;

  // Create mount point directory if it doesn't exist
  if (!existsSync(mountPoint)) {
    mkdirSync(mountPoint, { recursive: true });
  }

  let command: string;
  if (restrictToSubroot) {
    command = `gcsfuse --only-dir=${restrictToSubroot} --implicit-dirs ${bucketId} ${mountPoint}`;
  } else {
    command = `gcsfuse --implicit-dirs ${bucketId} ${mountPoint}`;
  }

  await execAsync(command);
}

export async function unmountGcsBucket(mountPoint: string): Promise<void> {
  try {
    await execAsync(`fusermount -u ${mountPoint}`);
  } catch (error) {
    // Ignore errors if mount point is not mounted
    console.warn(`Failed to unmount ${mountPoint}:`, error);
  }
}

async function getActiveMounts(gcsMountRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('mount');
    const mountLines = stdout.split('\n');
    const gcsMounts: string[] = [];

    for (const line of mountLines) {
      if (line.includes('gcsfuse') && line.includes(gcsMountRoot)) {
        // Extract mount point from mount line
        const parts = line.split(' on ');
        if (parts.length >= 2) {
          const mountPoint = parts[1].split(' ')[0];
          gcsMounts.push(mountPoint);
        }
      }
    }

    return gcsMounts;
  } catch (error) {
    console.warn('Failed to get active mounts:', error);
    return [];
  }
}

class WebSocketAgentServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  // Session ID -> SessionManager for each open websocket session.
  private sessions: Map<string, SessionManager> = new Map();
  private allowedOrigins: Set<string>;
  private sessionStorePath: string;
  private todosStorePath: string | null = null;
  private connectorsStorePath: string | null = null;
  private uploadedFilesPath: string | null = null;
  private restHandlers: RestHandlers;
  private jupyterMcpWrapper: JupyterMcpWrapper;

  constructor(port: number = 8080) {
    this.initialize(port);
  }

  private async initialize(port: number) {
    // Parse allowed origins from environment variable
    this.allowedOrigins = this.parseAllowedOrigins();

    // Initialize session storage
    this.initializeSessionStorage();

    // Initialize todos storage. NB: The TODOs file for a session is actually a link pointing to a session-specific storage file.
    // This link is shared between multiple sessions, so currently we can only have one session active at a time.
    this.initializeTodosStorage();

    // Initialize connectors storage (including GCS)
    await this.initializeConnectorsStorageAsync();

    // Create HTTP server first
    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

    // Create WebSocket server using the HTTP server
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info) => this.verifyClient(info)
    });

    let jupyterMcpTools: Array<ClaudeTool> = [];
    if (process.env.ENABLE_JUPYTER_MCP_SERVER === 'true') {
      jupyterMcpTools = await this.setupJupyterMcpServer();
    }

    await this.setupWebSocketServer(jupyterMcpTools);

    // Start the HTTP server
    this.httpServer.listen(port, () => {
      console.log(`HTTP/WebSocket server started on port ${port}`);
      console.log(`✅ CORS origin validation enabled for: ${Array.from(this.allowedOrigins).join(', ')}`);
    });
  }

  private parseAllowedOrigins(): Set<string> {
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;

    if (!allowedOriginsEnv || allowedOriginsEnv.trim() === '') {
      // Default to localhost:8081 for security
      return new Set(['http://localhost:8081']);
    }

    // Split by comma and trim whitespace
    const origins = allowedOriginsEnv
      .split(',')
      .map(origin => origin.trim())
      .filter(origin => origin.length > 0);

    if (origins.length === 0) {
      // Default to localhost:8081 for security
      return new Set(['http://localhost:8081']);
    }

    return new Set(origins);
  }

  private verifyClient(info: { origin: string; secure: boolean; req: any }): boolean {
    const { origin, req } = info;

    // Validate WebSocket URL path format: /ws/{session_id}
    const url = req.url;
    if (!url || !this.validateWebSocketPath(url)) {
      console.log(`❌ WebSocket connection rejected: Invalid path format '${url}'. Expected: /ws/{session_id}`);
      return false;
    }

    // Allow connections without origin (e.g., from non-browser clients like curl, Postman, etc.)
    if (!origin) {
      console.log('🔓 WebSocket connection allowed: No origin header (likely non-browser client)');
      return true;
    }

    // Check if the origin is in the allowed list
    if (this.allowedOrigins.has(origin)) {
      console.log(`✅ WebSocket connection allowed from origin: ${origin}`);
      return true;
    }

    console.log(`❌ WebSocket connection rejected from origin: ${origin}`);
    console.log(`   Allowed origins: ${Array.from(this.allowedOrigins).join(', ')}`);
    return false;
  }

  private validateWebSocketPath(url: string): boolean {
    // Expected format: /ws/{session_id}
    const pathPattern = /^\/ws\/([a-zA-Z0-9]+)$/;
    return pathPattern.test(url);
  }

  private extractSessionIdFromPath(url: string): string | null {
    // Extract session ID from /ws/{session_id} format
    const pathPattern = /^\/ws\/([a-zA-Z0-9]+)$/;
    const match = url.match(pathPattern);
    return match ? match[1] : null;
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    console.log(`🌐 Incoming HTTP request: ${req.method} ${req.url}`);

    // Check if this is a WebSocket upgrade request - if so, let the WebSocket server handle it
    if (req.headers.upgrade === 'websocket') {
      console.log('⬆️  WebSocket upgrade request detected, skipping HTTP handling');
      return; // Let the WebSocket server handle this
    }

    const origin = req.headers.origin;

    // Set CORS headers
    this.setCorsHeaders(res, origin);

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Parse URL and route to appropriate handler
    if (!req.url) {
      this.sendHttpError(res, 400, 'Bad Request: No URL provided');
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      this.routeHttpRequest(req.method || 'GET', url.pathname, req, res);
    } catch (error) {
      console.error('Error parsing URL:', error);
      this.sendHttpError(res, 400, 'Bad Request: Invalid URL');
    }
  }

  private setCorsHeaders(res: ServerResponse, origin?: string): void {
    // Check if origin is allowed (same logic as WebSocket)
    if (origin && this.allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
      // Allow non-browser clients (no origin header)
      res.setHeader('Access-Control-Allow-Origin', '*');
      console.log('🔓 HTTP request allowed: No origin header (likely non-browser client)');
    } else {
      // Origin not allowed - don't set CORS headers
      console.log(`❌ HTTP CORS rejected for origin: ${origin}`);
      console.log(`   Allowed origins: ${Array.from(this.allowedOrigins).join(', ')}`);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
  }

  private routeHttpRequest(method: string, pathname: string, req: IncomingMessage, res: ServerResponse): void {
    console.log(`📡 HTTP ${method} ${pathname}`);

    if (method === 'GET' && pathname === '/sessions') {
      this.restHandlers.handleListSessions(req, res);
    } else if (method === 'POST' && pathname === '/sessions') {
      this.restHandlers.handleCreateSession(req, res);
    } else if (method === 'GET' && pathname.startsWith('/sessions/')) {
      const sessionId = pathname.substring('/sessions/'.length);
      this.restHandlers.handleGetSession(sessionId, req, res);
    } else if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
      const sessionId = pathname.substring('/sessions/'.length);
      this.restHandlers.handleDeleteSession(sessionId, req, res);
    } else if (method === 'POST' && pathname.includes(':switch')) {
      // Handle POST /sessions/{session_id}:switch
      const match = pathname.match(/^\/sessions\/([^:]+):switch$/);
      if (match) {
        const sessionId = match[1];
        this.restHandlers.handleSwitchSession(sessionId, req, res);
      } else {
        this.sendHttpError(res, 400, 'Invalid switch session path format');
      }
    } else if (method === 'GET' && pathname === '/artifacts') {
      this.restHandlers.handleGetArtifacts(req, res);
    } else if (method === 'GET' && pathname.startsWith('/artifacts/')) {
      const artifactId = pathname.substring('/artifacts/'.length);
      this.restHandlers.handleGetArtifact(artifactId, req, res);
    } else if (method === 'GET' && pathname === '/connectors') {
      this.restHandlers.handleListConnectors(req, res);
    } else if (method === 'POST' && pathname === '/connectors') {
      this.restHandlers.handleCreateConnector(req, res);
    } else if (method === 'GET' && pathname.startsWith('/connectors/')) {
      const pathParts = pathname.split('/');
      if (pathParts.length === 3) {
        // GET /connectors/{id}
        const connectorId = pathParts[2];
        this.restHandlers.handleGetConnector(connectorId, req, res);
      } else if (pathParts.length === 4 && pathParts[3] === 'content') {
        // GET /connectors/{id}/content
        const connectorId = pathParts[2];
        this.restHandlers.handleGetConnectorContent(connectorId, req, res);
      } else {
        this.sendHttpError(res, 404, 'Not Found');
      }
    } else if (method === 'DELETE' && pathname.startsWith('/connectors/')) {
      const pathParts = pathname.split('/');
      if (pathParts.length === 3) {
        const connectorId = pathParts[2];
        this.restHandlers.handleDeleteConnector(connectorId, req, res);
      } else {
        this.sendHttpError(res, 404, 'Not Found');
      }
    } else if (method === 'POST' && pathname.includes(':upload')) {
      // Handle POST /connectors/{connector_id}:upload
      const match = pathname.match(/^\/connectors\/([^:]+):upload$/);
      if (match) {
        const connectorId = match[1];
        this.restHandlers.handleUploadToConnector(connectorId, req, res);
      } else {
        this.sendHttpError(res, 400, 'Invalid upload path format');
      }
    } else {
      this.sendHttpError(res, 404, 'Not Found');
    }
  }

  private sendJsonResponse(res: ServerResponse, statusCode: number, data: any): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify(data, null, 2));
  }

  private sendHttpError(res: ServerResponse, statusCode: number, message: string): void {
    this.sendJsonResponse(res, statusCode, { error: message });
  }

  private initializeSessionStorage(): void {
    const sessionStorePath = process.env.SESSION_STORE_PATH;

    if (!sessionStorePath) {
      throw new Error('❌  SESSION_STORE_PATH not configured');
    }

    // Create directory if it doesn't exist
    if (!existsSync(sessionStorePath)) {
      mkdirSync(sessionStorePath, { recursive: true });
      console.log(`📁 Created session store directory: ${sessionStorePath}`);
    }

    this.sessionStorePath = sessionStorePath;
    console.log(`✅ Session logging enabled, storing in: ${sessionStorePath}`);
  }

  private initializeTodosStorage(): void {
    const todosStorePath = process.env.TODOS_STORE_PATH;

    if (!todosStorePath) {
      console.log('⚠️  TODOS_STORE_PATH not configured, todos creation disabled');
      return;
    }

    try {
      // Create directory if it doesn't exist
      if (!existsSync(todosStorePath)) {
        mkdirSync(todosStorePath, { recursive: true });
        console.log(`📁 Created todos store directory: ${todosStorePath}`);
      }

      this.todosStorePath = todosStorePath;
      console.log(`✅ Todos creation enabled, storing in: ${todosStorePath}`);

    } catch (error) {
      console.error(`❌ Failed to initialize todos storage: ${error.message}`);
      this.todosStorePath = null;
    }
  }

  private createTodosFile(currentSessionId: string): void {
    if (!this.todosStorePath) {
      console.log('⚠️  Cannot create todos file: TODOS_STORE_PATH not configured');
      return;
    }

    if (!currentSessionId) {
      console.log('⚠️  Cannot create todos file: no current session ID');
      return;
    }

    const todosFilePath = join(this.todosStorePath, `${currentSessionId}.json`);

    // Only create if it doesn't already exist
    if (!existsSync(todosFilePath)) {
      const emptyTodoFile = { items: [] };
      writeFileSync(todosFilePath, JSON.stringify(emptyTodoFile, null, 2), 'utf-8');
      console.log(`📝 Created todos file: ${todosFilePath}`);
    } else {
      console.log(`📝 Todos file already exists: ${todosFilePath}`);
    }
  }

  private async initializeConnectorsStorageAsync(): Promise<void> {
    const workingDir = process.env.WORKING_DIRECTORY || ".";
    const connectorsStorePath = join(workingDir, '.terraine', 'connectors.jsonl');
    const uploadedFilesPath = join(workingDir, '.terraine', 'uploads');

    if (!connectorsStorePath) {
      console.log('⚠️  CONNECTORS_STORE_PATH not configured, connectors disabled');
      return;
    }

    try {
      // Create connectors directory if it doesn't exist
      const connectorsDir = resolve(connectorsStorePath).replace(/[^/]+$/, '');
      if (!existsSync(connectorsDir)) {
        mkdirSync(connectorsDir, { recursive: true });
      }

      this.connectorsStorePath = connectorsStorePath;
      console.log(`✅ Connectors enabled, storing in: ${connectorsStorePath}`);

      // Initialize uploaded files directory if configured
      if (uploadedFilesPath) {
        if (!existsSync(uploadedFilesPath)) {
          mkdirSync(uploadedFilesPath, { recursive: true });
          console.log(`📁 Created uploaded files directory: ${uploadedFilesPath}`);
        }
        this.uploadedFilesPath = uploadedFilesPath;
        console.log(`✅ File uploads enabled, storing in: ${uploadedFilesPath}`);
      } else {
        console.log('⚠️  UPLOADED_FILES_PATH not configured, file uploads disabled');
      }

      // Initialize GCS functionality
      await this.initializeGcs();

      // Initialize REST handlers after all storage paths are set
      this.restHandlers = new RestHandlers(
        this.connectorsStorePath,
        this.uploadedFilesPath,
        this.sessionStorePath,
        this.todosStorePath
      );

    } catch (error) {
      console.error(`❌ Failed to initialize connectors storage: ${error.message}`);
      this.connectorsStorePath = null;
      this.uploadedFilesPath = null;

      // Still initialize REST handlers even if storage failed
      this.restHandlers = new RestHandlers(
        this.connectorsStorePath,
        this.uploadedFilesPath,
        this.sessionStorePath,
        this.todosStorePath
      );
    }
  }

  private async initializeGcs(): Promise<void> {
    try {
      // Check if gcsfuse is installed
      const gcsfuseInstalled = await checkGcsfuseInstalled();
      if (!gcsfuseInstalled) {
        console.log('⚠️  gcsfuse not found in PATH, GCS connectors disabled');
        return;
      }

      console.log('✅ gcsfuse found, GCS connectors enabled');

      // Set up GCS mount root
      const gcsMountRoot = join(process.cwd(), '.terraine', 'gcs');
      if (!existsSync(gcsMountRoot)) {
        mkdirSync(gcsMountRoot, { recursive: true });
        console.log(`📁 Created GCS mount root: ${gcsMountRoot}`);
      }

      // Check for and unmount any existing mounts
      const activeMounts = await getActiveMounts(gcsMountRoot);
      for (const mountPoint of activeMounts) {
        console.log(`🔄 Unmounting existing GCS mount: ${mountPoint}`);
        await unmountGcsBucket(mountPoint);
      }

      // Synchronize existing GCS connectors from connectors.jsonl
      await this.synchronizeGcsConnectors();

    } catch (error) {
      console.warn(`⚠️  GCS initialization failed: ${error.message}`);
    }
  }

  private async synchronizeGcsConnectors(): Promise<void> {
    if (!this.connectorsStorePath || !existsSync(this.connectorsStorePath)) {
      return;
    }

    try {
      const content = readFileSync(this.connectorsStorePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      const gcsMountRoot = join(process.cwd(), '.terraine', 'gcs');

      for (const line of lines) {
        const connector = JSON.parse(line) as DataConnector;

        if (connector.type === 'gcs' && connector.status === 'active' && connector.config.gcs_url) {
          const gcsConfig = parseGcsUrl(connector.config.gcs_url);
          if (gcsConfig) {
            const mountPoint = connector.config.local_mount_point_path;
            if (mountPoint && existsSync(mountPoint)) {
              // Check if already mounted
              const activeMounts = await getActiveMounts(gcsMountRoot);
              if (!activeMounts.includes(mountPoint)) {
                console.log(`🔄 Re-mounting GCS connector: ${connector.name}`);
                await mountGcsBucket(gcsConfig, mountPoint);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️  Failed to synchronize GCS connectors: ${error.message}`);
    }
  }

  private async setupJupyterMcpServer(): Promise<Array<ClaudeTool>> {
    const configPath: string | undefined = process.env.JUPYTER_MCP_SERVER_CONFIG_JSON_PATH;
    if (!configPath) {
      throw new Error('Set JUPYTER_MCP_SERVER_CONFIG_JSON_PATH in env before launching.');
    }
    this.jupyterMcpWrapper = new JupyterMcpWrapper(configPath!);

    await this.jupyterMcpWrapper.initialize();
    const tools = await this.jupyterMcpWrapper.retrieveTools();

    return tools;
  }

  private setupWebSocketServer(jupyterTools: Array<ClaudeTool>) {
    console.log(`CODEX_UNSAFE_ALLOW_NO_SANDBOX=${process.env.CODEX_UNSAFE_ALLOW_NO_SANDBOX}`);
    this.wss.on('connection', (ws, req) => {
      // Extract session ID from WebSocket path
      const sessionId = this.extractSessionIdFromPath(req.url || '');
      if (!sessionId) {
        console.log('❌ WebSocket connection rejected: Could not extract session ID');
        ws.close(1008, 'Invalid session ID in path');
        return;
      }

      console.log(`Client connected to session: ${sessionId}`);

      this.createTodosFile(sessionId);
      this.sessions[sessionId] = new SessionManager(sessionId, ws, this.sessionStorePath!, jupyterTools);
    });
  }

  private cleanupSession() {
    for (const sessionId in this.sessions) {
      this.sessions[sessionId].cleanup();
      delete this.sessions[sessionId];
    }
  }

  public close() {
    this.cleanupSession();
    this.wss.close();
    this.httpServer.close();
  }
}

export function loadArtifactsIndex(): ArtifactsIndex | null {
  const workingDir = process.env.WORKING_DIRECTORY;
  if (!workingDir) {
    throw new Error('❌  WORKING_DIRECTORY not configured');
  }
  const artifactsIndexPath = join(workingDir, '.terraine', 'artifact_catalog.json');

  if (!existsSync(artifactsIndexPath)) {
    console.error(`❌ Artifacts index file not found: ${artifactsIndexPath}`);
    return null;
  }

  try {
    const fileContent = readFileSync(artifactsIndexPath, 'utf-8');
    const artifactsIndex: ArtifactsIndex = JSON.parse(fileContent);

    // Validate the structure
    if (!artifactsIndex.artifacts_root_path || !Array.isArray(artifactsIndex.artifacts)) {
      console.error('❌ Invalid artifacts index structure');
      return null;
    }

    console.log(`✅ Loaded ${artifactsIndex.artifacts.length} artifacts from ${artifactsIndexPath}`);
    return artifactsIndex;

  } catch (error) {
    console.error(`❌ Error reading artifacts index file: ${error.message}`);
    return null;
  }
}

// Exported helper functions for RestHandlers
export function updateConnectorLastUsed(connectorId: string, connectorsStorePath: string | null): void {
  if (!connectorsStorePath) {
    return;
  }

  try {
    const content = readFileSync(connectorsStorePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const connectors: DataConnector[] = lines.map(line => JSON.parse(line));

    const connector = connectors.find(c => c.id === connectorId);

    if (connector) {
      connector.last_used = new Date().toISOString();

      // Rewrite the file with updated connector
      const updatedContent = connectors.map(c => JSON.stringify(c)).join('\n') + '\n';
      writeFileSync(connectorsStorePath, updatedContent);
    }
  } catch (error) {
    console.error(`Error updating connector last used: ${error.message}`);
  }
}

export function updateConnectorInStorage(connectorId: string, updates: Partial<DataConnector>, connectorsStorePath: string | null): boolean {
  if (!connectorsStorePath) {
    return false;
  }

  try {
    const content = readFileSync(connectorsStorePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const connectors: DataConnector[] = lines.map(line => JSON.parse(line));

    const connectorIndex = connectors.findIndex(c => c.id === connectorId);

    if (connectorIndex === -1) {
      return false; // Connector not found
    }

    // Apply updates
    connectors[connectorIndex] = { ...connectors[connectorIndex], ...updates };

    // Rewrite the file with updated connector
    const updatedContent = connectors.map(c => JSON.stringify(c)).join('\n') + '\n';
    writeFileSync(connectorsStorePath, updatedContent);
    return true;
  } catch (error) {
    console.error(`Error updating connector: ${error.message}`);
    return false;
  }
}

export function detectFileType(filePath: string, mimeType?: string): string {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  if (ext === '.txt' || ext === '.md' || ext === '.log') return 'text';
  if (mimeType && mimeType.startsWith('text/')) return 'text';

  return 'binary';
}

export function getFileMetadata(filePath: string): { file_size: number; mime_type: string; last_modified: string } | null {
  try {
    const stats = statSync(filePath);
    const ext = extname(filePath).toLowerCase();

    let mimeType = 'application/octet-stream';
    if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.csv') mimeType = 'text/csv';
    else if (ext === '.json') mimeType = 'application/json';
    else if (ext === '.md') mimeType = 'text/markdown';
    else if (ext === '.log') mimeType = 'text/plain';

    return {
      file_size: stats.size,
      mime_type: mimeType,
      last_modified: stats.mtime.toISOString()
    };
  } catch (error) {
    console.error(`Error getting file metadata: ${error.message}`);
    return null;
  }
}

// Initialize environment and working directory before starting server
initializeEnvironment();

// Initialize logger and show current log level
const logger = initLogger();
if (logger.isLoggingEnabled()) {
  const logLevel = process.env.LOG_LEVEL || process.env.DEBUG || 'none';
  debug(`🐛 Logging enabled with level: ${logLevel.toUpperCase()}`);
}

// Example usage
const server = new WebSocketAgentServer(8080, './jupyter-mcp-server.json');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});
