import type { TagFailure } from '../domain/tagging.js';
import type { ReportTag } from '../domain/types.js';

/** One classification: a tag from the fixed set, or why there is none. Never throws for a failed call. */
export type TagResult =
  { ok: true; tag: ReportTag; status: number } | { ok: false; failure: TagFailure };

/**
 * The LLM behind tagging (DESIGN §8.2). Receives only the report text. The adapter validates the model's answer
 * against `ReportTag`, so a result with `ok: true` is always a listed tag. One try per call; the caller never retries.
 */
export interface Tagger {
  tag(reportText: string): Promise<TagResult>;
}
