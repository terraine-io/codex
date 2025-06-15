import { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, unlinkSync, symlinkSync, lstatSync, renameSync, readlinkSync, readdirSync } from 'fs';
import { basename, join, extname } from 'path';
import { randomUUID } from 'crypto';

// Import types and utility functions that will be exported from ws-server
import type { DataConnector, SessionEvent, SessionInfo, ArtifactItem, ArtifactsIndex } from './ws-server.js';
import { parseGcsUrl, checkGcsfuseInstalled, mountGcsBucket, unmountGcsBucket, loadArtifactsIndex, updateConnectorLastUsed, updateConnectorInStorage, detectFileType, getFileMetadata } from './ws-server.js';

export class RestHandlers {
  private connectorsStorePath: string | null = null;
  private uploadedFilesPath: string | null = null;
  private sessionStorePath: string | null = null;
  private todosStorePath: string | null = null;

  constructor(
    connectorsStorePath: string | null,
    uploadedFilesPath: string | null,
    sessionStorePath: string | null,
    todosStorePath: string | null
  ) {
    this.connectorsStorePath = connectorsStorePath;
    this.uploadedFilesPath = uploadedFilesPath;
    this.sessionStorePath = sessionStorePath;
    this.todosStorePath = todosStorePath;
  }

  // Helper methods
  private sendHttpError(res: ServerResponse, statusCode: number, message: string): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify({ error: message }));
  }

  private sendJsonResponse(res: ServerResponse, statusCode: number, data: any): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data, null, 2));
  }

  private generateSessionId(): string {
    return randomUUID().replace(/-/g, '');
  }

  private generateConnectorId(): string {
    return `conn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  handleListSessions(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.sessionStorePath) {
        this.sendHttpError(res, 503, 'Session storage not configured');
        return;
      }

      const sessions = this.getSessionsList();
      this.sendJsonResponse(res, 200, { sessions });
    } catch (error) {
      console.error('Error handling /sessions request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading sessions');
    }
  }

  handleListConnectors(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.connectorsStorePath) {
        this.sendHttpError(res, 503, 'Connectors storage not configured');
        return;
      }

      const connectors = this.loadConnectors();
      this.sendJsonResponse(res, 200, { connectors });
    } catch (error) {
      console.error('Error handling /connectors request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading connectors');
    }
  }

  handleGetSession(sessionId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.sessionStorePath) {
        this.sendHttpError(res, 503, 'Session storage not configured');
        return;
      }

      const sessionFile = join(this.sessionStorePath, `${sessionId}.jsonl`);
      if (!existsSync(sessionFile)) {
        this.sendHttpError(res, 404, 'Session not found');
        return;
      }

      const content = readFileSync(sessionFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      const events: SessionEvent[] = [];

      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch (error) {
          console.warn('Failed to parse session event:', error);
        }
      }

      const stats = statSync(sessionFile);
      let startTime = stats.birthtime.toISOString();
      if (events.length > 0) {
        startTime = events[0].timestamp;
      }

      const sessionData = {
        id: sessionId,
        start_time: startTime,
        last_update_time: stats.mtime.toISOString(),
        event_count: events.length,
        events: events
      };

      this.sendJsonResponse(res, 200, sessionData);
    } catch (error) {
      console.error('Error handling /sessions/:id request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading session');
    }
  }

  handleCreateSession(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.sessionStorePath) {
        this.sendHttpError(res, 503, 'Session storage not configured');
        return;
      }

      const sessionId = this.generateSessionId();
      const timestamp = new Date().toISOString();
      
      // Create session file
      const sessionFile = join(this.sessionStorePath, `${sessionId}.jsonl`);
      const initialEvent: SessionEvent = {
        timestamp,
        event_type: 'session_created',
        direction: 'outgoing',
        message_data: { event: 'session_created' }
      };
      
      writeFileSync(sessionFile, JSON.stringify(initialEvent) + '\n');

      // Create todos file if todos storage is configured
      if (this.todosStorePath) {
        if (!existsSync(this.todosStorePath)) {
          mkdirSync(this.todosStorePath, { recursive: true });
        }
        
        const todosFile = join(this.todosStorePath, `${sessionId}.md`);
        const todosContent = `# Terraine Session Todos

Session ID: \`${sessionId}\`
Created: ${timestamp}

This file helps the agent plan and track tasks for the current session.

## Current Tasks

- [ ] No tasks yet - add your goals here

## Completed Tasks

(Tasks will be moved here when completed)

---

*This file was auto-created for session tracking. You can edit it manually or let the agent update it.*
`;
        writeFileSync(todosFile, todosContent);
      }

      const sessionInfo: SessionInfo = {
        id: sessionId,
        start_time: timestamp,
        last_update_time: timestamp,
        event_count: 1
      };

      this.sendJsonResponse(res, 201, sessionInfo);
    } catch (error) {
      console.error('Error creating session:', error);
      this.sendHttpError(res, 500, 'Internal server error while creating session');
    }
  }

  handleDeleteSession(sessionId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.sessionStorePath) {
        this.sendHttpError(res, 503, 'Session storage not configured');
        return;
      }

      // Validate session ID format
      if (!/^[a-f0-9]{40}$/.test(sessionId)) {
        this.sendHttpError(res, 400, 'Invalid session ID format');
        return;
      }

      const sessionFile = join(this.sessionStorePath, `${sessionId}.jsonl`);
      if (!existsSync(sessionFile)) {
        this.sendHttpError(res, 404, 'Session not found');
        return;
      }

      // Archive session file by renaming to hidden file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivedSessionFile = join(this.sessionStorePath, `.${sessionId}-${timestamp}.jsonl`);
      
      try {
        renameSync(sessionFile, archivedSessionFile);
        console.log(`📚 Session archived: ${sessionFile} -> ${archivedSessionFile}`);
      } catch (error) {
        console.error('Error archiving session file:', error);
        this.sendHttpError(res, 500, 'Failed to archive session file');
        return;
      }

      // Archive todos file if it exists
      if (this.todosStorePath) {
        const todosFile = join(this.todosStorePath, `${sessionId}.md`);
        if (existsSync(todosFile)) {
          const archivedTodosFile = join(this.todosStorePath, `.${sessionId}-${timestamp}.md`);
          try {
            renameSync(todosFile, archivedTodosFile);
            console.log(`📚 Todos archived: ${todosFile} -> ${archivedTodosFile}`);
          } catch (error) {
            console.error('Error archiving todos file:', error);
          }
        }

        // Clean up symlink if it points to this session
        const symlinkPath = join(process.cwd(), '.terraine-todos.md');
        if (existsSync(symlinkPath)) {
          try {
            const stats = lstatSync(symlinkPath);
            if (stats.isSymbolicLink()) {
              const linkTarget = readlinkSync(symlinkPath);
              if (linkTarget.includes(`${sessionId}.md`)) {
                unlinkSync(symlinkPath);
                console.log(`🧹 Cleaned up symlink: ${symlinkPath}`);
              }
            }
          } catch (error) {
            console.error('Error cleaning up symlink:', error);
          }
        }
      }

      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    } catch (error) {
      console.error('Error deleting session:', error);
      this.sendHttpError(res, 500, 'Internal server error while deleting session');
    }
  }

  handleSwitchSession(sessionId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.todosStorePath) {
        this.sendHttpError(res, 503, 'Todos storage not configured');
        return;
      }

      if (!this.sessionStorePath) {
        this.sendHttpError(res, 503, 'Session storage not configured');
        return;
      }

      // Validate session ID format
      if (!/^[a-f0-9]{40}$/.test(sessionId)) {
        this.sendHttpError(res, 400, 'Invalid session ID format');
        return;
      }

      const sessionFile = join(this.sessionStorePath, `${sessionId}.jsonl`);
      if (!existsSync(sessionFile)) {
        this.sendHttpError(res, 404, 'Session not found');
        return;
      }

      const todosFile = join(this.todosStorePath, `${sessionId}.md`);
      const symlinkPath = join(process.cwd(), '.terraine-todos.md');

      // Check if .terraine-todos.md exists as a regular file (protect it)
      if (existsSync(symlinkPath)) {
        const stats = lstatSync(symlinkPath);
        if (!stats.isSymbolicLink()) {
          this.sendHttpError(res, 409, 'Conflict: .terraine-todos.md exists as a regular file and cannot be overwritten');
          return;
        }
        // Remove existing symlink
        unlinkSync(symlinkPath);
      }

      // Create todos file if it doesn't exist
      if (!existsSync(todosFile)) {
        if (!existsSync(this.todosStorePath)) {
          mkdirSync(this.todosStorePath, { recursive: true });
        }
        
        const timestamp = new Date().toISOString();
        const todosContent = `# Terraine Session Todos

Session ID: \`${sessionId}\`
Created: ${timestamp}

This file helps the agent plan and track tasks for the current session.

## Current Tasks

- [ ] No tasks yet - add your goals here

## Completed Tasks

(Tasks will be moved here when completed)

---

*This file was auto-created for session tracking. You can edit it manually or let the agent update it.*
`;
        writeFileSync(todosFile, todosContent);
      }

      // Create symlink
      symlinkSync(todosFile, symlinkPath);

      const switchInfo = {
        session_id: sessionId,
        todos_file: todosFile,
        symlink_path: symlinkPath,
        message: `Switched to session ${sessionId}. Agent can now access todos via .terraine-todos.md`
      };

      this.sendJsonResponse(res, 200, switchInfo);
    } catch (error) {
      console.error('Error switching session:', error);
      this.sendHttpError(res, 500, 'Internal server error while switching session');
    }
  }

  handleCreateConnector(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (!this.connectorsStorePath) {
          this.sendHttpError(res, 503, 'Connectors storage not configured');
          return;
        }

        let requestData: any;
        try {
          requestData = JSON.parse(body);
        } catch (error) {
          this.sendHttpError(res, 400, 'Invalid JSON in request body');
          return;
        }

        const { name, type } = requestData;
        if (!name || !type) {
          this.sendHttpError(res, 400, 'Missing required fields: name, type');
          return;
        }

        if (type !== 'local_file' && type !== 'gcs') {
          this.sendHttpError(res, 400, 'Invalid connector type. Must be "local_file" or "gcs"');
          return;
        }

        const connectorId = this.generateConnectorId();
        const timestamp = new Date().toISOString();

        if (type === 'local_file') {
          const { filename = 'upload.txt', file_type = 'text', encoding = 'utf-8' } = requestData;

          const connector: DataConnector = {
            id: connectorId,
            name,
            type: 'local_file',
            config: {
              filename,
              file_type: file_type as 'csv' | 'json' | 'text' | 'binary',
              encoding
            },
            status: 'pending_upload',
            created_at: timestamp
          };

          this.saveConnector(connector);
          this.sendJsonResponse(res, 201, connector);

        } else if (type === 'gcs') {
          const { config } = requestData;
          if (!config?.gcs_url) {
            this.sendHttpError(res, 400, 'Missing required field: config.gcs_url');
            return;
          }

          const gcsUrl = config.gcs_url;
          let parsedGcs;
          try {
            parsedGcs = parseGcsUrl(gcsUrl);
          } catch (error) {
            this.sendHttpError(res, 400, `Invalid GCS URL: ${error.message}`);
            return;
          }

          // Check if gcsfuse is available
          const gcsfuseCheck = await checkGcsfuseInstalled();
          if (!gcsfuseCheck.available) {
            this.sendHttpError(res, 500, `gcsfuse not available: ${gcsfuseCheck.error}`);
            return;
          }

          // Mount the bucket
          try {
            const mountResult = await mountGcsBucket(parsedGcs.bucket, parsedGcs.subroot);
            
            const connector: DataConnector = {
              id: connectorId,
              name,
              type: 'gcs',
              config: {
                gcs_url: gcsUrl,
                local_mount_point_path: mountResult.mountPoint
              },
              status: 'active',
              created_at: timestamp
            };

            this.saveConnector(connector);
            this.sendJsonResponse(res, 201, connector);

          } catch (error) {
            console.error('Failed to mount GCS bucket:', error);
            this.sendHttpError(res, 500, `Failed to mount GCS bucket: ${error.message}`);
            return;
          }
        }

      } catch (error) {
        console.error('Error creating connector:', error);
        this.sendHttpError(res, 500, 'Internal server error while creating connector');
      }
    });
  }

  handleGetConnector(connectorId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.connectorsStorePath) {
        this.sendHttpError(res, 503, 'Connectors storage not configured');
        return;
      }

      // Validate connector ID format
      if (!/^conn_[a-f0-9]{12}$/.test(connectorId)) {
        this.sendHttpError(res, 400, 'Invalid connector ID format');
        return;
      }

      const connectors = this.loadConnectors();
      const connector = connectors.find(c => c.id === connectorId);
      
      if (!connector) {
        this.sendHttpError(res, 404, 'Connector not found');
        return;
      }

      // Add metadata for active connectors
      if (connector.status === 'active' && connector.type === 'local_file') {
        const filePath = connector.config.file_path;
        if (filePath && existsSync(filePath)) {
          const stats = statSync(filePath);
          connector.metadata = {
            file_size: stats.size,
            last_modified: stats.mtime.toISOString()
          };
        }
      }

      this.sendJsonResponse(res, 200, connector);
    } catch (error) {
      console.error('Error handling /connectors/:id request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading connector');
    }
  }

  handleDeleteConnector(connectorId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.connectorsStorePath) {
        this.sendHttpError(res, 503, 'Connectors storage not configured');
        return;
      }

      // Validate connector ID format
      if (!/^conn_[a-f0-9]{12}$/.test(connectorId)) {
        this.sendHttpError(res, 400, 'Invalid connector ID format');
        return;
      }

      const connectors = this.loadConnectors();
      const connectorIndex = connectors.findIndex(c => c.id === connectorId);
      
      if (connectorIndex === -1) {
        this.sendHttpError(res, 404, 'Connector not found');
        return;
      }

      const connector = connectors[connectorIndex];

      // Handle cleanup based on connector type
      if (connector.type === 'local_file') {
        // Delete associated file if it exists
        const filePath = connector.config.file_path;
        if (filePath && existsSync(filePath)) {
          try {
            unlinkSync(filePath);
            console.log(`🗑️  Deleted connector file: ${filePath}`);
          } catch (error) {
            console.error('Error deleting connector file:', error);
          }
        }
      } else if (connector.type === 'gcs') {
        // Unmount GCS bucket
        const mountPoint = connector.config.local_mount_point_path;
        if (mountPoint) {
          unmountGcsBucket(mountPoint).catch(error => {
            console.error('Error unmounting GCS bucket:', error);
          });
        }
      }

      // Remove from connectors list and save
      connectors.splice(connectorIndex, 1);
      this.saveConnectorsList(connectors);

      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    } catch (error) {
      console.error('Error deleting connector:', error);
      this.sendHttpError(res, 500, 'Internal server error while deleting connector');
    }
  }

  handleGetArtifacts(req: IncomingMessage, res: ServerResponse): void {
    try {
      const artifactsIndex = loadArtifactsIndex();

      if (!artifactsIndex) {
        // Return empty list if no index file is configured or available
        this.sendJsonResponse(res, 200, { artifacts: [] });
        return;
      }

      // Add relative_file_path to each artifact and rename overview to overview_md
      const enrichedArtifacts = artifactsIndex.artifacts.map(artifact => ({
        artifact_id: artifact.artifact_id,
        file_path: artifact.file_path,
        overview_md: artifact.overview,
        relative_file_path: basename(artifact.file_path)
      }));

      // Return the artifacts from the index file
      this.sendJsonResponse(res, 200, {
        artifacts: enrichedArtifacts,
        artifacts_root_path: artifactsIndex.artifacts_root_path
      });

    } catch (error) {
      console.error('Error handling /artifacts request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading artifacts');
    }
  }

  handleGetArtifact(artifactId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!artifactId) {
        this.sendHttpError(res, 400, 'Artifact ID is required');
        return;
      }

      const artifactsIndex = loadArtifactsIndex();

      if (!artifactsIndex) {
        this.sendHttpError(res, 503, 'Artifacts index not configured or available');
        return;
      }

      // Find the artifact with the matching artifact_id
      const artifact = artifactsIndex.artifacts.find(a => a.artifact_id === artifactId);

      if (!artifact) {
        this.sendHttpError(res, 404, `Artifact not found with ID: ${artifactId}`);
        return;
      }

      // Check if the artifact file actually exists
      if (!existsSync(artifact.file_path)) {
        this.sendHttpError(res, 404, `Artifact file not found on disk: ${artifact.file_path}`);
        return;
      }

      // Read the artifact content
      let content: string;
      try {
        content = readFileSync(artifact.file_path, 'utf-8');
      } catch (readError) {
        console.error(`Error reading artifact file ${artifact.file_path}:`, readError);
        this.sendHttpError(res, 500, `Failed to read artifact content: ${readError.message}`);
        return;
      }

      // Get file metadata
      const stats = statSync(artifact.file_path);
      const ext = extname(artifact.file_path).toLowerCase();
      
      let mimeType = 'application/octet-stream';
      if (ext === '.txt') mimeType = 'text/plain';
      else if (ext === '.md') mimeType = 'text/markdown';
      else if (ext === '.json') mimeType = 'application/json';
      else if (ext === '.html') mimeType = 'text/html';
      else if (ext === '.css') mimeType = 'text/css';
      else if (ext === '.js') mimeType = 'application/javascript';
      else if (ext === '.py') mimeType = 'text/plain';

      // Return the artifact with its content
      this.sendJsonResponse(res, 200, {
        artifact_id: artifact.artifact_id,
        file_path: artifact.file_path,
        overview_md: artifact.overview,
        relative_file_path: basename(artifact.file_path),
        content: content,
        metadata: {
          file_size: stats.size,
          mime_type: mimeType,
          last_modified: stats.mtime.toISOString()
        }
      });

    } catch (error) {
      console.error('Error handling /artifacts/:id request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading artifact');
    }
  }

  handleGetConnectorContent(connectorId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      // Validate connector ID format
      if (!/^conn_[a-zA-Z0-9]+$/.test(connectorId)) {
        this.sendHttpError(res, 400, 'Invalid connector ID format');
        return;
      }

      if (!this.connectorsStorePath) {
        this.sendHttpError(res, 503, 'Connectors storage not configured');
        return;
      }

      const connectors = this.loadConnectors();
      const connector = connectors.find(c => c.id === connectorId);
      
      if (!connector) {
        this.sendHttpError(res, 404, 'Connector not found');
        return;
      }

      if (connector.status !== 'active') {
        this.sendHttpError(res, 409, `Connector is not active (status: ${connector.status})`);
        return;
      }

      // Check if file exists
      if (!connector.config.file_path || !existsSync(connector.config.file_path)) {
        this.sendHttpError(res, 404, 'File not found');
        return;
      }

      // Parse query parameters for chunking
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const limit = parseInt(url.searchParams.get('limit') || '0');
      const bytesStart = parseInt(url.searchParams.get('bytes_start') || '0');
      const bytesEnd = parseInt(url.searchParams.get('bytes_end') || '0');

      try {
        let content: string;
        let chunkInfo: any = {};
        
        // Read file content
        const fileContent = readFileSync(connector.config.file_path, connector.config.encoding || 'utf-8');
        const metadata = getFileMetadata(connector.config.file_path);
        
        if (limit > 0) {
          // Line-based chunking
          const lines = fileContent.split('\n');
          const endLine = offset + limit;
          const selectedLines = lines.slice(offset, endLine);
          content = selectedLines.join('\n');
          
          chunkInfo = {
            offset,
            limit,
            total_lines: lines.length
          };
        } else if (bytesEnd > bytesStart) {
          // Byte-based chunking
          content = fileContent.substring(bytesStart, bytesEnd);
          chunkInfo = {
            bytes_start: bytesStart,
            bytes_end: bytesEnd,
            total_bytes: fileContent.length
          };
        } else {
          // Full content
          content = fileContent;
        }

        // Update last used timestamp
        updateConnectorLastUsed(connectorId, this.connectorsStorePath);

        const response = {
          connector_id: connectorId,
          content,
          encoding: connector.config.encoding || 'utf-8',
          content_type: metadata?.mime_type || 'text/plain',
          total_size: metadata?.file_size || 0,
          ...(Object.keys(chunkInfo).length > 0 && { chunk_info: chunkInfo })
        };

        this.sendJsonResponse(res, 200, response);
      } catch (readError) {
        console.error(`Error reading file: ${readError.message}`);
        this.sendHttpError(res, 500, 'Failed to read file content');
      }
    } catch (error) {
      console.error(`Error handling GET /connectors/${connectorId}/content request:`, error);
      this.sendHttpError(res, 500, 'Internal server error while reading connector content');
    }
  }

  handleUploadToConnector(connectorId: string, req: IncomingMessage, res: ServerResponse): void {
    // Validate connector ID format
    if (!/^conn_[a-zA-Z0-9]+$/.test(connectorId)) {
      this.sendHttpError(res, 400, 'Invalid connector ID format');
      return;
    }

    if (!this.connectorsStorePath) {
      this.sendHttpError(res, 503, 'Connectors storage not configured');
      return;
    }

    if (!this.uploadedFilesPath) {
      this.sendHttpError(res, 503, 'File uploads not configured');
      return;
    }

    // Find the connector
    const connectors = this.loadConnectors();
    const connector = connectors.find(c => c.id === connectorId);
    
    if (!connector) {
      this.sendHttpError(res, 404, 'Connector not found');
      return;
    }

    // GCS connectors don't support content uploads
    if (connector.type === 'gcs') {
      this.sendHttpError(res, 400, 'Content upload not supported for GCS connectors. Files are accessed directly via the mounted file system.');
      return;
    }

    if (connector.status !== 'pending_upload') {
      this.sendHttpError(res, 409, 'Connector is not in pending_upload status');
      return;
    }

    // Read simple POST body content
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        if (!body || body.trim().length === 0) {
          this.sendHttpError(res, 400, 'Empty content body');
          return;
        }

        // Use filename from connector config, or generate one if not specified
        let filename: string;
        if (connector.config.filename) {
          // Use the filename specified during connector creation
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const ext = extname(connector.config.filename);
          const baseName = basename(connector.config.filename, ext);
          filename = `${connectorId}_${baseName}_${timestamp}${ext}`;
        } else {
          // Fallback to generated filename based on file type
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const fileExtension = connector.config.file_type === 'csv' ? '.csv' : 
                               connector.config.file_type === 'json' ? '.json' : '.txt';
          filename = `${connectorId}_${timestamp}${fileExtension}`;
        }
        const filePath = join(this.uploadedFilesPath!, filename);

        // Write file content
        writeFileSync(filePath, body, connector.config.encoding || 'utf-8');

        // Get file metadata
        const metadata = getFileMetadata(filePath);
        if (!metadata) {
          this.sendHttpError(res, 500, 'Failed to read uploaded file metadata');
          return;
        }

        // Update connector with file information
        const updates: Partial<DataConnector> = {
          config: {
            ...connector.config,
            file_path: filePath,
            file_type: connector.config.file_type || detectFileType(filePath, metadata.mime_type)
          },
          status: 'active',
          metadata
        };

        const updateSuccess = updateConnectorInStorage(connectorId, updates, this.connectorsStorePath);
        if (!updateSuccess) {
          this.sendHttpError(res, 500, 'Failed to update connector');
          return;
        }

        // Get updated connector to return
        const updatedConnectors = this.loadConnectors();
        const updatedConnector = updatedConnectors.find(c => c.id === connectorId);
        
        console.log(`✅ Uploaded content to connector: ${connectorId} (${connector.name})`);
        this.sendJsonResponse(res, 200, updatedConnector);

      } catch (writeError) {
        console.error('Error writing uploaded content:', writeError);
        this.sendHttpError(res, 500, 'Failed to save uploaded content');
      }
    });
  }

  // Helper methods for data loading
  private getSessionsList(): SessionInfo[] {
    if (!this.sessionStorePath || !existsSync(this.sessionStorePath)) {
      return [];
    }

    const files = readdirSync(this.sessionStorePath);
    const sessions: SessionInfo[] = [];

    for (const file of files) {
      if (file.endsWith('.jsonl') && !file.startsWith('.')) {
        const sessionId = file.replace('.jsonl', '');

        try {
          const filePath = join(this.sessionStorePath, file);
          const stats = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.trim().split('\n').filter(line => line.trim());

          let startTime = stats.birthtime.toISOString();
          if (lines.length > 0) {
            try {
              const firstEvent = JSON.parse(lines[0]) as SessionEvent;
              startTime = firstEvent.timestamp;
            } catch {
              // Fallback to file stats
            }
          }

          sessions.push({
            id: sessionId,
            start_time: startTime,
            last_update_time: stats.mtime.toISOString(),
            event_count: lines.length
          });
        } catch (error) {
          console.warn(`Failed to read session file ${file}:`, error);
        }
      }
    }

    // Sort by last update time (newest first)
    return sessions.sort((a, b) => new Date(b.last_update_time).getTime() - new Date(a.last_update_time).getTime());
  }

  private loadConnectors(): DataConnector[] {
    if (!this.connectorsStorePath || !existsSync(this.connectorsStorePath)) {
      return [];
    }

    try {
      const content = readFileSync(this.connectorsStorePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      return lines.map(line => JSON.parse(line) as DataConnector);
    } catch (error) {
      console.error('Failed to load connectors:', error);
      return [];
    }
  }

  private saveConnector(connector: DataConnector): void {
    if (!this.connectorsStorePath) {
      throw new Error('Connectors storage path not configured');
    }

    // Ensure directory exists
    const dir = basename(this.connectorsStorePath);
    if (dir !== this.connectorsStorePath && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Append to JSONL file
    const line = JSON.stringify(connector) + '\n';
    writeFileSync(this.connectorsStorePath, line, { flag: 'a' });
  }

  private saveConnectorsList(connectors: DataConnector[]): void {
    if (!this.connectorsStorePath) {
      throw new Error('Connectors storage path not configured');
    }

    // Ensure directory exists
    const dir = basename(this.connectorsStorePath);
    if (dir !== this.connectorsStorePath && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write entire list as JSONL
    const content = connectors.map(connector => JSON.stringify(connector)).join('\n') + '\n';
    writeFileSync(this.connectorsStorePath, content);
  }
}