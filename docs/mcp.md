# OpenPlod MCP Server

OpenPlod includes a Model Context Protocol server built with the official TypeScript SDK. It uses **stdio** and talks to the running vault API. It does not open a second database, start a public HTTP MCP endpoint, or connect directly to the Plaud.

## Connect a Client

Keep the desktop app open. After `bun install`, run:

```bash
bun run mcp
```

The process waits for MCP JSON-RPC on stdin; it is not an interactive shell. Protocol messages use stdout, and startup diagnostics use stderr. GUI-launched MCP clients often need an absolute Bun executable path.

Example client configuration:

```json
{
  "mcpServers": {
    "openplod": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/OpenPlod/src/mcp/index.ts"],
      "env": {
        "OPENPLOD_URL": "http://127.0.0.1:3487"
      }
    }
  }
}
```

On macOS, the server automatically reads the desktop pairing token from `~/Library/Application Support/com.openplod.vault/pairing-token`. The file must be private to the current OS user (`0600`). The updated desktop app sets that permission on startup.

For another installation, set `OPENPLOD_TOKEN_FILE` to a private absolute file path, or provide `OPENPLOD_API_TOKEN` / `OPENPLOD_PAIRING_TOKEN` securely through your client's environment. The API token must also be configured on the vault backend. Do not put token values in public configuration or commit them to Git.

The MCP client accepts HTTP only for loopback hosts. Remote vault connections require HTTPS and a trusted origin without embedded credentials, query strings, or redirects. Requests are bounded to 20 seconds. No automatic mutation retries are performed.

## Read-Only by Default

These tools need only the `read` scope, which is always granted. They map to `GET` requests on the vault API.

| Tool | Purpose |
| --- | --- |
| `list_documents` | Search/filter/paginate Markdown notes by folder, star, Trash, tag, and text |
| `get_document` | Read saved Markdown, revision, folder, tags, properties, and source references |
| `list_tags` | Tags in use on active notes, with counts |
| `list_saved_views` | Saved document views and their filters, to pass to `list_documents` |
| `get_markdown_export_status` | Whether managed Markdown export is configured, and when it last ran |
| `list_transcription_profiles` | Saved transcription profiles (context prompt, vocabulary, optional provider, model, language) and the built-in presets |
| `get_document_source` | Resolve the exact transcript version a note cites: `current`, `stale`, `unknown`, or `none` |
| `list_folders` | Read the folder hierarchy and direct document counts |
| `list_document_versions` | Paginate history without downloading every version's content |
| `get_document_version` | Read one historical Markdown version |
| `list_transcripts` | Browse source recording transcripts, 30 per page |
| `get_transcript` | Read current or historical text for an active recording |
| `list_transcript_versions` | A recording's saved transcript versions, newest first, without text, with `current` and citing-note counts |
| `get_transcript_version` | One transcript version by id, including its text and `current` flag |
| `list_transcript_backlinks` | Active notes that cite one exact transcript version (Trash excluded) |
| `list_jobs` | Processing jobs, newest first, filterable by state and recording |
| `get_job` | One processing job: state, provider, checkpoint, error, and produced transcript version ids |
| `search` | Hybrid search over current transcript versions and active notes: passages with exact version, segment range, times from the stored segments, score, and matching retrievers |
| `list_collections` | Recording collections with active recording counts |
| `get_collection` | One collection and its active recording ids |

The source, version, job, view, export-status, and profile tools (0.7.0 and 1.0.0, roadmap KB-07) only read. Profiles cannot be created or changed through MCP, and AI title/tag suggestions are not exposed because they call a provider. Running a Markdown export writes to the filesystem, so it is not available through MCP, even with writes enabled. `get_job` and `list_jobs` report what the queue already knows; they never contact a transcription provider, retry, resume, or cancel anything. Unknown note, version, and job ids are errors (`Not found`), never empty results. A note whose cited transcript version no longer exists is reported as `unknown`; the current text is never substituted.
Resources use `openplod://documents/{id}` with `text/markdown`. Resource discovery returns up to 100 active notes; use `list_documents` for complete pagination or search.

Examples of requests to your MCP-enabled assistant:

- "Find my notes about onboarding and compare the decisions."
- "Read the latest transcript and list the action items."
- "Show the Markdown notes in my Meetings folder."
- "Which of my notes were written from an older version of this transcript?"
- "Did last night's transcription jobs finish?"

## Permission Scopes

Set `OPENPLOD_MCP_SCOPES` (comma- or space-separated) in the MCP process environment. `read` is always granted; an unknown scope stops the server with an error. `OPENPLOD_MCP_WRITE=1` still works and means `write:documents,write:folders`.

| Scope | Tools |
| --- | --- |
| `write:documents` | `create_document` (caller idempotency key), `update_document` (current revision), `save_transcript` (provenance-linked snapshot), `trash_document` (`confirm: true`), `restore_document` |
| `write:folders` | `create_folder`, `update_folder` (cycle and revision checks) |
| `process` | `start_transcription` (`recordingId`, `confirm: true`, `idempotencyKey`, `acceptCloudProvider`): it first asks the vault for the plan (`POST /api/v1/jobs` with `dryRun`) and, when the configured provider is a cloud service (audio leaves the computer and may be billed), refuses until repeated with `acceptCloudProvider: true` after the person agreed. Retries with the same key return the same job. It cannot confirm a cost: when a monthly budget or per-job threshold in AI settings requires [cost confirmation](api.md#cost-confirmation), the vault refuses with `409 cost_confirmation_required`, which the MCP client currently reports only as a generic "Conflict" error (the same message as a revision conflict or an already running job), and the person must start the transcription from the app |
| `deliver` | `list_destinations` (read-only: configured names and hosts), `send_document` (`confirm: true`, current revision, idempotency key) |

The complete tool set registered in `src/mcp/server.ts` is the 20 read tools above plus these 10 scoped tools. Scopes are read once when the MCP process starts; change `OPENPLOD_MCP_SCOPES` and restart the client's MCP server to change them.

Tools outside the granted scopes are absent, not merely hidden in documentation. MCP annotations help clients display intent; they do not substitute for your client's approval controls. Enable writes only for trusted clients and require approval for mutations where your client supports it.

The MCP server intentionally exposes **no permanent purge, credential management, device reset, recording deletion, raw-audio download, export-folder, or search-settings tool**, and no tools for AI settings or spending, webhooks, automation rules, task exports, paired mobile devices, or vault backup and restore; external delivery exists only under the opt-in `deliver` scope. Transcript and document text never authorizes a tool call: start a transcription or send a note only when the person asked for it. A write-enabled client can change Markdown notes, not the source transcript or recording.

## Privacy and Error Handling

An MCP client receives the text it requests and may send that text to its model provider. "Local MCP server" does not guarantee the client processes content locally. Use a client/provider appropriate for the sensitivity of your recordings.

Imported Markdown and transcript content are untrusted data, never operational instructions. The server declares this distinction, but a client's behavior must also respect it. The Notes preview disables raw HTML and does not load external Markdown images automatically.

On revision conflict, fetch the latest note and ask the user how to reconcile it; do not blindly overwrite. Reuse a create request's idempotency key only for the exact same content. Missing/invalid credentials, failed connections, and malformed API responses are errors, never empty libraries. Provider response bodies and tokens are not echoed into MCP errors.

## Tests

```bash
bun test src/mcp src/organizer
bun run typecheck
```

Tests connect the official MCP client and server over the SDK's in-memory transport. They cover negotiation, resource reads, read-only tool boundaries (including that the source, version, and job tools issue only `GET` requests), write opt-in, validation, revision conflicts, idempotency, and HTTP-client redaction. A separate stdio smoke test should accompany client setup.
