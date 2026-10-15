import type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions } from './types';
import { WhisperEngine } from './whisper';
import { MistralEngine } from './mistral';
import { DeepgramEngine } from './deepgram';
import { OpenAiEngine, transcriptionFailure } from './openai';
import { AssemblyAiEngine } from './assemblyai';
import { validateSpeechOptions } from '../ai/capabilities';
import type { SpeechProvider } from '../ai/config';

export type EngineName = SpeechProvider;
export interface RouterConfig { primary: EngineName; fallback: EngineName[]; defaults?: TranscriptionOptions; localOnly?: boolean; beforeAttempt?: (provider: EngineName) => void }
export interface ProviderCredentials { mistralApiKey?: string; deepgramApiKey?: string; openaiApiKey?: string; assemblyaiApiKey?: string }
export class TranscriptionRouter {
  private engines: Map<EngineName, TranscriptionEngine>;
  private config: RouterConfig;
  constructor(config?: Partial<RouterConfig>, credentials: ProviderCredentials = {}) {
    this.config = { primary: 'whisper', fallback: [], ...config };
    this.engines = new Map<EngineName, TranscriptionEngine>([
      ['whisper', new WhisperEngine()], ['mistral', new MistralEngine(credentials.mistralApiKey)], ['deepgram', new DeepgramEngine(credentials.deepgramApiKey)],
      ['openai', new OpenAiEngine(credentials.openaiApiKey)], ['assemblyai', new AssemblyAiEngine(credentials.assemblyaiApiKey)],
    ]);
  }
  /** The same engines and options with fallbacks removed, so every chunk of one recording uses one provider. */
  primaryOnly(): TranscriptionRouter {
    const copy = Object.create(TranscriptionRouter.prototype) as TranscriptionRouter;
    copy.engines = this.engines; copy.config = { ...this.config, fallback: [] };
    return copy;
  }
  status(): Record<EngineName, boolean> { return Object.fromEntries([...this.engines].map(([name, engine]) => [name, engine.isAvailable()])) as Record<EngineName, boolean>; }
  private async run(call: (engine: TranscriptionEngine, options: TranscriptionOptions) => Promise<TranscriptionResult>, options?: TranscriptionOptions) {
    const errors: string[] = [];
    for (const [index, name] of [...new Set([this.config.primary, ...this.config.fallback])].entries()) {
      options?.signal?.throwIfAborted();
      this.config.beforeAttempt?.(name);
      if (this.config.localOnly && name !== 'whisper') return transcriptionFailure('router', 'Local-only mode blocks cloud transcription. Select Whisper.cpp.');
      const engine = this.engines.get(name);
      if (!engine?.isAvailable()) { errors.push(`${name}: not configured`); continue; }
      // Model identifiers and remote job IDs never cross provider boundaries.
      const opts = { ...this.config.defaults, ...options, ...(index ? { model: undefined, checkpoint: undefined } : {}) };
      if (opts.language === 'auto') opts.language = undefined;
      // A fallback that cannot honour the requested options is skipped, never run with
      // features silently dropped; an incompatible primary still fails loudly.
      if (index) {
        try { validateSpeechOptions(name, opts); }
        catch (error) { errors.push(error instanceof Error ? error.message : `${name}: unsupported options`); continue; }
      } else validateSpeechOptions(name, opts);
      const result = await call(engine, opts);
      options?.signal?.throwIfAborted();
      if (result.success) return result;
      errors.push(result.error || `${name}: failed`);
      if (name === 'assemblyai') break;
    }
    return transcriptionFailure('router', errors.join('; ') || 'No transcription provider selected.');
  }
  transcribeFile(path: string, options?: TranscriptionOptions) { return this.run((engine, opts) => engine.transcribeFile(path, opts), options); }
  transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions) { return this.run((engine, opts) => engine.transcribeBuffer(buffer, mimetype, opts), options); }
  transcribeWithDiarization(path: string, options?: TranscriptionOptions) { return this.transcribeFile(path, { ...options, diarize: true }); }
}
