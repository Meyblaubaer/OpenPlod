# Provider Privacy and Cost

OpenPlod stores recordings locally. Data leaves your computer only when you choose a cloud
provider for a task, enable OpenWhistle forwarding, or connect an MCP client whose model sees the
text it requests. This page says what goes where. Provider terms, retention and prices change;
check the provider's current documentation and your account settings. OpenPlod does not state
prices.

## What each provider receives

| Provider | Tasks | Receives | Endpoint |
| --- | --- | --- | --- |
| Whisper.cpp | Transcription | Nothing leaves the computer | Local binary |
| Ollama | Summaries, documents, chat | Nothing leaves the computer (127.0.0.1 only; remote/cloud Ollama models are excluded) | `127.0.0.1:11434` |
| Mistral | Transcription, summaries, documents, chat | Audio file (transcription); transcript text and your question (text tasks) | `api.mistral.ai` |
| OpenAI | Transcription, summaries, documents, chat | Audio file, optional context prompt and vocabulary; transcript text | `api.openai.com` |
| Deepgram | Transcription | Audio file, optional vocabulary | `api.deepgram.com` |
| AssemblyAI | Transcription | Audio file (uploaded, then processed asynchronously), optional vocabulary | `api.assemblyai.com` |
| Anthropic | Summaries, documents, chat | Transcript text and your question | `api.anthropic.com` |
| OpenWhistle (optional forwarding) | Agents/connectors | Imported audio | The base URL you configure |

Connection checks send only metadata, never audio or transcript text.

## Controls

- **Local-only mode** blocks every cloud provider and OpenWhistle forwarding. It cannot recall a
  request that was already sent.
- **Per task:** transcription, summaries, documents and chat each have their own provider.
- **Fallback is off by default.** A saved fallback list is an explicit extra destination for audio.
- **Provider check before sending:** document and chat requests carry the provider you saw; a
  changed provider returns a conflict instead of sending.

## API keys

- Mistral, Deepgram, OpenAI, AssemblyAI, Anthropic, and OpenWhistle keys entered in Settings are
  stored in the vault database encrypted with AES-256-GCM under a random local key in `vault.key`
  (mode `0600`) in the data directory. Older plaintext keys are encrypted on the first start of
  this version.
- **Not yet encrypted:** the Gemini and custom-endpoint keys, task connector tokens (Todoist,
  Linear, Notion), and webhook signing secrets are stored in the vault database without this
  encryption, and unencrypted backups do not remove them.
- This protects keys in database copies and unencrypted backups. It does **not** protect against
  someone who can read your data directory, because the key file is beside the database. Protect
  your OS account and use disk encryption.
- Environment variables (`MISTRAL_API_KEY`, `OPENAI_API_KEY`, …) remain a fallback and are never
  written to the database.
- Settings and the API return only whether a key is configured, never the key.
- Unencrypted backups exclude the encrypted keys listed above; encrypted backups include `vault.key`.
- Request logs redact token, key, secret, passphrase and signature query parameters and long
  opaque path segments.

## Network transport

The desktop app listens on the local network so the Android companion can pair. **Plain HTTP on
the LAN is not secure remote access:** the pairing token and audio travel unencrypted on that
network. Use a trusted network, do not port-forward the service, and do not expose it to the
internet. To serve HTTPS, set `OPENPLOD_TLS_CERT` and `OPENPLOD_TLS_KEY` to PEM certificate and key
files; the server warns at startup when it listens on a non-loopback address without TLS.

## Cost

- OpenPlod shows provider usage when the provider reports it and labels it unknown otherwise.
- OpenPlod estimates transcription cost from a dated table of documented list prices and can ask
  for confirmation above a per-job threshold or a monthly budget (see
  [spending limits](ai-providers.md#spending-limits-and-prices)). These are estimates, not bills,
  and no provider enforces them. Set budgets and alerts in each provider's account as well.
- Cancelling a job stops local work; a request already submitted may still be processed and
  billed. Interrupted synchronous cloud calls are not resubmitted automatically, to avoid paying
  twice. AssemblyAI jobs resume by their remote ID without re-uploading.
- Files over a provider's upload limit (OpenAI 25 MB, AssemblyAI 100 MB in OpenPlod) are split into
  overlapping chunks when the model returns timestamps and speaker labels are off; otherwise they
  are refused before anything is sent (see [long audio](ai-providers.md#long-audio)). Chunk overlap
  is billed.

## Retention on your side

- Transcripts, versions, documents and chat history stay in the vault until you delete them.
- Trash keeps recordings for 30 days, then purges them (see [recovery](recovery.md#purge)).
- Backup archives keep everything they contain until you delete the archive.

See also [AI providers](ai-providers.md) for models and capabilities, and [MCP](mcp.md) for
assistant access.
