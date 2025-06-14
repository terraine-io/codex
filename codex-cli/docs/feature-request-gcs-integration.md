## Overview
We want to enable the `terraine` agent to connect with Google Cloud Storage via `gcsfuse`.
The gist is that when the user adds a connector of type `gcs`, the server should mount the requested Google Cloud bucket onto local mount point.
The `terraine` agent will be informed about this mount point in its system prompt, and will thereafter be able to interact with the remotely mounted buckets via regular unix commands such as `ls`, `cat`, etc.

## Details

### Server startup
At startup time, the server code should:
1. Run `gcsfuse -v` in the shell to ensure it is installed
2. Check that the path `gcsMountRoot = join(process.env.WORKING_DIRECTORY, '.terraine', 'gcs')` exists
3. Check whether there are any active mounts under `gcsMountRoot`. If so, unmount them.
4. Examine the file `${WORKING_DIRECTORY}/.terraine/connectors.jsonl`, and synchronize the connectors with the local file system:
    * For each `type: "gcs"` connector in `connectors.jsonl`, mount it at its corresponding mount point (see **MOUNT** in the following section)

### Connector creation
When the client invokes `POST /connectors` to create a `type: "gcs"` connector, the handler should:
- **Validate** that the incoming request's `config.gcs_url` attribute is a valid URI of the form:
    * `gs://<BUCKET_ID>`: mount the bucket `BUCKET_ID`, and give access to all files/subdirectories without restriction, or
    * `gs://<BUCKET_ID>/restrict/to/subroot`: mount the bucket and ONLY give access to the tree under `/restrict/to/subroot`
    * The parsed URI will yield two variables: `${gcsBucketId}` and (optionally -- only if the URI contained a `/restrict/to/subroot`) `${restrictToSubroot}`
- [Optional, for truthy `${restrictToSubroot}`] **Create local subdirectory** under `${gcsMountRoot}` to match the specified `/restrict/to/subroot`
- **MOUNT** the bucket (with optional path) by invoking `gcsfuse`:
    * If `${restrictToSubroot}` is empty:
    ```
    gcsfuse --implicit-dirs ${bucketId} ${gcsMountRoot}/${bucketId}
    ```
    * If `${restrictToSubroot}` is specified:
    ```
    gcsfuse --only-dir=${restrictToSubroot} --implicit-dirs ${bucketId} ${gcsMountRoot}/${bucketId}/${restrictToSubroot}
    ```
- Record the `local_mount_point_path` attribute for the connector in the `connectors.jsonl` file

### Connector deletion
Whenever the client invokes `DELETE /connectors/{connector_id}`, delete the corresponding `connectors.jsonl` entry, and then unmount the bucket:
```
fusermount -u ${gcsMountRoot}/${bucketId}/${restrictToSubroot}
```

## Task
Implement the above feature, and ensure that documentation in `CONNECTOR_API.md` and `WS_README.md` are up to date.