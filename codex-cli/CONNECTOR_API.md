# Connector API Documentation

## Overview

The Connector API provides a REST interface for managing data connectors that allow agents to access various types of data sources. The API supports two types of connectors:

- **Local File Connectors**: For uploading and storing files locally. Follows a two-step process: create connector, then upload content.
- **Google Cloud Storage (GCS) Connectors**: For mounting Google Cloud Storage buckets as local file systems using `gcsfuse`.

## Base URL
```
http://localhost:8080
```

## API Endpoints

### 1. List Connectors
```http
GET /connectors
```

**Description:** Retrieve a list of all available connectors.

**Response (200):**
```json
{
  "connectors": [
    {
      "id": "conn_4f86a15ad103",
      "name": "Customer Data",
      "type": "local_file",
      "config": {
        "filename": "customers.csv",
        "file_type": "csv",
        "encoding": "utf-8",
        "file_path": "/uploads/conn_4f86a15ad103_customers_2024-12-06T10-30-00Z.csv"
      },
      "status": "active",
      "created_at": "2024-12-06T10:30:00Z",
      "last_used": "2024-12-06T11:15:00Z",
      "metadata": {
        "file_size": 2048,
        "mime_type": "text/csv",
        "last_modified": "2024-12-06T10:30:00Z"
      }
    },
    {
      "id": "conn_7b92c54fd801",
      "name": "Analytics Bucket",
      "type": "gcs",
      "config": {
        "gcs_url": "gs://my-analytics-bucket/data",
        "local_mount_point_path": "/working-dir/.terraine/gcs/my-analytics-bucket/data"
      },
      "status": "active",
      "created_at": "2024-12-06T12:00:00Z"
    }
  ]
}
```

### 2. Create Connector
```http
POST /connectors
```

**Description:** Create a new connector. The behavior depends on the connector type.

#### 2a. Create Local File Connector

**Request Body:**
```json
{
  "name": "Customer Data",
  "type": "local_file",
  "filename": "customers.csv",
  "file_type": "csv",
  "encoding": "utf-8"
}
```

**Request Fields:**
- `name` (required): Display name for the connector
- `type` (required): Must be `"local_file"`
- `filename` (optional): Desired filename for uploaded content
- `file_type` (optional): Type of file (`csv`, `json`, `text`, `binary`)
- `encoding` (optional): Text encoding (defaults to `utf-8`)

**Response (201):**
```json
{
  "id": "conn_4f86a15ad103",
  "name": "Customer Data",
  "type": "local_file",
  "config": {
    "filename": "customers.csv",
    "file_type": "csv",
    "encoding": "utf-8"
  },
  "status": "pending_upload",
  "created_at": "2024-12-06T10:30:00Z"
}
```

#### 2b. Create GCS Connector

**Request Body:**
```json
{
  "name": "Analytics Bucket",
  "type": "gcs",
  "config": {
    "gcs_url": "gs://my-analytics-bucket/data"
  }
}
```

**Request Fields:**
- `name` (required): Display name for the connector
- `type` (required): Must be `"gcs"`
- `config.gcs_url` (required): GCS URL in format:
  - `gs://bucket-name` - Mount entire bucket
  - `gs://bucket-name/path/to/subroot` - Mount only specific subdirectory

**Response (201):**
```json
{
  "id": "conn_7b92c54fd801",
  "name": "Analytics Bucket",
  "type": "gcs",
  "config": {
    "gcs_url": "gs://my-analytics-bucket/data",
    "local_mount_point_path": "/working-dir/.terraine/gcs/my-analytics-bucket/data"
  },
  "status": "active",
  "created_at": "2024-12-06T12:00:00Z"
}
```

**Note:** GCS connectors are immediately active after creation and mounting. No upload step is required.

### 3. Get Connector Details
```http
GET /connectors/{id}
```

**Description:** Retrieve details for a specific connector.

**Path Parameters:**
- `id`: Connector ID (format: `conn_[alphanumeric]`)

**Response (200):**
```json
{
  "id": "conn_4f86a15ad103",
  "name": "Customer Data",
  "type": "local_file",
  "config": {
    "filename": "customers.csv",
    "file_type": "csv",
    "encoding": "utf-8",
    "file_path": "/uploads/conn_4f86a15ad103_customers_2024-12-06T10-30-00Z.csv"
  },
  "status": "active",
  "created_at": "2024-12-06T10:30:00Z",
  "metadata": {
    "file_size": 2048,
    "mime_type": "text/csv",
    "last_modified": "2024-12-06T10:30-00Z"
  }
}
```

### 4. Upload Content to Connector
```http
POST /connectors/{id}:upload
```

**Description:** Upload file content to an existing **local file** connector. The connector status will change from `pending_upload` to `active` upon successful upload.

**Note:** This endpoint is only available for `local_file` connectors. GCS connectors do not support content uploads as files are accessed directly through the mounted file system.

**Path Parameters:**
- `id`: Connector ID

**Request Headers:**
```
Content-Type: text/plain
```

**Request Body:** Raw file content (plain text)

**Example:**
```
name,age,city,country
John,25,New York,USA
Jane,30,San Francisco,USA
Bob,35,Los Angeles,USA
```

**Response (200):**
```json
{
  "id": "conn_4f86a15ad103",
  "name": "Customer Data",
  "type": "local_file",
  "config": {
    "filename": "customers.csv",
    "file_type": "csv",
    "encoding": "utf-8",
    "file_path": "/uploads/conn_4f86a15ad103_customers_2024-12-06T10-30-00Z.csv"
  },
  "status": "active",
  "created_at": "2024-12-06T10:30:00Z",
  "metadata": {
    "file_size": 2048,
    "mime_type": "text/csv",
    "last_modified": "2024-12-06T10:30:00Z"
  }
}
```

**Error Response (400) - GCS Connector:**
```json
{
  "error": "Content upload not supported for GCS connectors. Files are accessed directly via the mounted file system."
}
```

### 5. Get Connector Content
```http
GET /connectors/{id}/content
```

**Description:** Retrieve the uploaded file content from an active connector.

**Path Parameters:**
- `id`: Connector ID

**Query Parameters (optional):**
- `offset`: Starting line number (0-based, for line-based chunking)
- `limit`: Maximum number of lines to return
- `bytes_start`: Starting byte position (for byte-based chunking)
- `bytes_end`: Ending byte position

**Examples:**
```http
GET /connectors/conn_123/content                    # Full content
GET /connectors/conn_123/content?limit=10           # First 10 lines
GET /connectors/conn_123/content?offset=5&limit=10  # Lines 5-14
```

**Response (200):**
```json
{
  "connector_id": "conn_4f86a15ad103",
  "content": "name,age,city,country\nJohn,25,New York,USA\nJane,30,San Francisco,USA",
  "encoding": "utf-8",
  "content_type": "text/csv",
  "total_size": 2048,
  "chunk_info": {
    "offset": 0,
    "limit": 10,
    "total_lines": 150
  }
}
```

### 6. Delete Connector
```http
DELETE /connectors/{id}
```

**Description:** Remove a connector and its associated file.

**Path Parameters:**
- `id`: Connector ID

**Response (204):** No content

## Data Types

### Connector Object
```typescript
interface Connector {
  id: string;                    // Unique identifier (conn_[alphanumeric])
  name: string;                  // Display name
  type: "local_file";            // Connector type
  config: {
    filename?: string;           // Original filename
    file_path?: string;          // Server-side file path (after upload)
    file_type?: "csv" | "json" | "text" | "binary";
    encoding?: string;           // Text encoding
  };
  status: "pending_upload" | "active" | "inactive" | "error";
  created_at: string;            // ISO timestamp
  last_used?: string;            // ISO timestamp
  metadata?: {
    file_size?: number;          // File size in bytes
    mime_type?: string;          // MIME type
    last_modified?: string;      // ISO timestamp
  };
}
```

### Status Values
- `pending_upload`: Connector created, waiting for content upload
- `active`: Content uploaded successfully, ready for access
- `inactive`: Connector disabled
- `error`: Error state (e.g., file not found)

## Error Responses

All error responses follow this format:
```json
{
  "error": "Error message description"
}
```

### Common HTTP Status Codes
- `200`: Success
- `201`: Created
- `204`: No Content (successful deletion)
- `400`: Bad Request (invalid input, missing fields)
- `404`: Not Found (connector or content not found)
- `409`: Conflict (invalid status for operation)
- `503`: Service Unavailable (storage not configured)

### Example Error Responses

**Invalid Connector ID:**
```json
{
  "error": "Invalid connector ID format"
}
```

**Connector Not Ready for Content Access:**
```json
{
  "error": "Connector is not active (status: pending_upload)"
}
```

**Missing Required Field:**
```json
{
  "error": "Missing required field: name"
}
```

## Usage Examples

### JavaScript/TypeScript

```typescript
// Create a connector
const response = await fetch('/connectors', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Sales Data',
    filename: 'sales-2024.csv',
    file_type: 'csv'
  })
});
const connector = await response.json();

// Upload content
await fetch(`/connectors/${connector.id}:upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: csvContent
});

// Retrieve content with chunking
const contentResponse = await fetch(
  `/connectors/${connector.id}/content?offset=0&limit=100`
);
const { content, chunk_info } = await contentResponse.json();
```

#### GCS Connector Example
```javascript
// Create GCS connector (immediately active)
const response = await fetch('/connectors', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Data Lake',
    type: 'gcs',
    config: {
      gcs_url: 'gs://my-data-lake/analytics'
    }
  })
});
const connector = await response.json();
// connector.status is already 'active' - no upload needed

// Access files directly via local mount point
console.log('Mount point:', connector.config.local_mount_point_path);
// Agent can now use ls, cat, etc. on the mount point
```

### cURL Examples

#### Local File Connector
```bash
# Create local file connector
curl -X POST http://localhost:8080/connectors \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Data", "type": "local_file", "filename": "test.csv", "file_type": "csv"}'

# Upload content
curl -X POST "http://localhost:8080/connectors/conn_123:upload" \
  -H "Content-Type: text/plain" \
  --data-binary @data.csv

# Get content with pagination
curl "http://localhost:8080/connectors/conn_123/content?offset=10&limit=20"
```

#### GCS Connector
```bash
# Create GCS connector (automatically mounts)
curl -X POST http://localhost:8080/connectors \
  -H "Content-Type: application/json" \
  -d '{"name": "Analytics Bucket", "type": "gcs", "config": {"gcs_url": "gs://my-bucket/data"}}'

# List connectors to see mount point
curl http://localhost:8080/connectors

# Delete connector (automatically unmounts)
curl -X DELETE http://localhost:8080/connectors/conn_456
```

## Integration Notes

### Local File Connectors
1. **Two-Step Process**: Always create the connector first, then upload content
2. **Status Checking**: Verify connector status is `active` before accessing content
3. **Chunking**: Use offset/limit parameters for large files to avoid memory issues
4. **File Management**: Uploaded files are automatically managed server-side with unique names

### GCS Connectors
1. **Prerequisites**: Requires `gcsfuse` to be installed and Google Cloud authentication configured
2. **Immediate Activation**: GCS connectors are immediately `active` after creation (no upload step)
3. **File System Access**: Agent can use standard Unix commands (`ls`, `cat`, `find`, etc.) on the mount point
4. **Automatic Cleanup**: Deleting a GCS connector automatically unmounts the file system
5. **Path Structure**: Mount points follow the pattern: `{working-dir}/.terraine/gcs/{bucket-id}/{subroot}`

### General Notes
1. **Error Handling**: Check HTTP status codes and error messages for proper error handling
2. **Concurrent Access**: Multiple connectors can be active simultaneously
3. **Authentication**: GCS connectors inherit Google Cloud credentials from the server environment