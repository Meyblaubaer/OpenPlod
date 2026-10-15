# Getting Started with OpenPlod 1.0

This guide takes you from a fresh install to a first transcript and document. It takes a few
minutes; device authorization for a Plaud recorder is separate and is covered in the
[README](../README.md#get-recordings-from-plaud).

## 1. Install and open

Build the desktop app for [macOS](../README.md#build-the-mac-app) or
[Linux](../README.md#build-the-linux-app), or run the vault from source:

```bash
bun install && bun install --cwd web
bun run build        # the web interface
bun run dev          # the vault on http://127.0.0.1:3487
```

`bun run doctor` checks Bluetooth, `ffmpeg`, and recorder authorization and names the fix for
anything missing.

## 2. The setup guide

The first time OpenPlod opens, a five-step guide appears. You can skip it at any point and run it
again from **Settings > About OpenPlod** or the command palette (⌘K / Ctrl+K, "Run the setup
guide").

1. **Welcome.** What OpenPlod keeps where.
2. **Where AI runs.**
   - *Local only*: Whisper.cpp transcribes and Ollama writes documents on this machine. Every cloud
     call, including fallbacks, is blocked.
   - *Providers I choose*: audio or text goes only to the providers you pick, with your own keys.
3. **Transcription model.** Choose Whisper.cpp, Mistral Voxtral, OpenAI, Deepgram, or AssemblyAI,
   then a model and a language ("Detect automatically" is the default). Each card lists what the
   provider supports: a context prompt, vocabulary, speaker labels. Cloud providers ask for an API
   key; **Check** confirms it by listing your models and sends no audio. Keys are stored in this
   vault and never shown again.
4. **What you usually record.** Pick a profile preset, or skip. See below.
5. **First recording.** Go to Plaud over Bluetooth, import files, record with the microphone, pair
   an Android phone, or start with documents.

Nothing in the guide sends a recording anywhere. It only saves settings.

## 3. Transcription profiles

A profile tells the speech model what it is listening to: a short **context prompt** and a
**vocabulary** of names, products, and acronyms to spell correctly. It can also pin a provider,
model, language, and speaker labels.

| Preset | Prompt describes | Speaker labels |
| --- | --- | --- |
| Team meeting | Colleagues, projects, decisions, action items | On |
| Réunion (français) | A work meeting in French; sets the language to French | On |
| Medical consultation | Clinician and patient, drug names, dosages | On |
| Legal discussion | Parties, case names, statutes, clauses | On |
| Lecture or class | One speaker, technical vocabulary | Off |
| Interview or podcast | Host and guest, questions and answers | On |
| Engineering standup | Code, pull requests, deployments; includes a starter vocabulary | On |
| Customer call | Pricing, contracts, features, follow-ups | On |

Manage profiles in **Settings > Transcription profiles**: add from a preset, edit, delete. Choose
the default under **Settings > AI providers > Default profile**. When you transcribe a recording,
the dialog lets you switch profile and add context for that one recording ("Dr Martin and a
patient discuss amoxicillin").

Tips:

- Describe the recording; do not give orders. "A product review that mentions Voxtral and
  OpenPlod" works; "Spell everything correctly" does not.
- Keep the prompt in the language of the audio.
- Put proper nouns in the vocabulary. It is the part every provider except Mistral can use.
- A profile that is not pinned to a provider works everywhere: the parts a provider cannot take are
  left out, the dialog says so before you start, and the transcript's provenance records it.

Which provider takes what is listed in [AI providers](ai-providers.md#prompts-vocabulary-and-profiles-100).

## 4. From transcript to document

Open a transcript and choose **Create document** for meeting minutes, interview notes, a brief,
and more; review the Markdown before saving. In **Documents**, tag notes, save views, and use
**Suggest** in a note's tag row to get an AI title and tags. Nothing changes until you click a
suggestion. Set `OPENPLOD_EXPORT_DIR` to mirror notes into an Obsidian folder
([details](api.md#managed-markdown-export)).

## 5. Find anything

Press ⌘K / Ctrl+K anywhere. Type to search recordings, transcripts, and documents, or to run a quick
action: import, record, open Plaud, transcription profiles, the API and MCP page, or the setup guide.
Use the arrow keys and Enter.

## 6. Language, backups, and automation

- **Language.** OpenPlod follows your system language (French or English). Change it in
  **Settings > Language** or on the first screen of the setup guide.
- **Backups.** **Settings > Backup & restore** creates a full-vault archive, optionally encrypted
  with a passphrase, and verifies it. See [backup and restore](backup-and-restore.md).
- **Spending.** Set a monthly budget and a per-job threshold in **Settings > AI providers**. Cloud
  jobs show an estimate and ask before going over.
- **Automation.** The **Automations** page holds opt-in rules, signed webhooks, and reviewed task
  exports. See [automation](automation.md).

## What 1.0.0 does not promise

OpenPlod 1.0.0 ships with [documented support boundaries](../ROADMAP.md#100-status): direct
Plaud extraction is verified on one authorized Note Pro, cloud AI paths are contract-tested but not
live-accepted, and release signing needs your keys. Back up your vault folder before upgrading.
