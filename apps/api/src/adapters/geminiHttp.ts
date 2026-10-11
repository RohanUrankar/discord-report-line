import { z } from 'zod';

import {
  parseTagOutput,
  TAG_SYSTEM_INSTRUCTION,
  tagRequestText,
  type TagFailure,
} from '../domain/tagging.js';
import { ReportTag } from '../domain/types.js';
import type { Tagger, TagResult } from '../ports/tagger.js';
import { isTimeout, readBoundedBody } from './httpCall.js';

// Gemini API, generateContent (https://ai.google.dev/api/generate-content). The key travels in the
// `x-goog-api-key` header, never in the URL, so it cannot land in a proxy log, an error message or a stack.
// The enum in `responseSchema` makes the model answer with a listed word; the answer is validated against the
// same list again here, because a schema is a request, not a guarantee.

const API_KEY_HEADER = 'x-goog-api-key';
/** A tag answer is a few hundred bytes with its metadata; anything near this is not one. */
const MAX_RESPONSE_BYTES = 16 * 1024;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

export interface GeminiHttpOptions {
  /** e.g. `https://generativelanguage.googleapis.com/v1beta`. Operator config; a test points it at a stub. */
  apiBaseUrl: string;
  /** A real secret. Used only for the request header; never logged, stored or put in a result. */
  apiKey: string;
  /** A model id such as `gemini-3.5-flash-lite` (validated by config: letters, digits, dot, dash). */
  model: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

/** The part of the response we read; everything else Gemini sends is ignored. */
const GenerateContentResponse = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z.looseObject({
          parts: z.array(z.looseObject({ text: z.string().optional() })),
        }),
      }),
    )
    .min(1),
});

export class GeminiHttpTagger implements Tagger {
  public constructor(private readonly options: GeminiHttpOptions) {}

  public async tag(reportText: string): Promise<TagResult> {
    let response: Response;
    try {
      response = await (this.options.fetchFn ?? fetch)(this.url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: this.options.apiKey },
        body: JSON.stringify(this.requestBody(reportText)),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return failed({ kind: isTimeout(error) ? 'timeout' : 'network' });
    }
    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      await response.body?.cancel().catch(() => undefined);
      return failed({ kind: 'http', status: response.status });
    }
    return this.readTag(response);
  }

  private url(): string {
    return `${this.options.apiBaseUrl}/models/${encodeURIComponent(this.options.model)}:generateContent`;
  }

  private requestBody(reportText: string): object {
    return {
      systemInstruction: { parts: [{ text: TAG_SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: tagRequestText(reportText) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { tag: { type: 'STRING', enum: [...ReportTag] } },
          required: ['tag'],
        },
      },
    };
  }

  private async readTag(response: Response): Promise<TagResult> {
    let body: { text: string; truncated: boolean };
    try {
      body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      return failed({ kind: isTimeout(error) ? 'timeout' : 'network' });
    }
    const text = body.truncated ? undefined : answerText(body.text);
    const tag = text === undefined ? undefined : parseTagOutput(text);
    return tag === undefined
      ? failed({ kind: 'invalid_output' })
      : { ok: true, tag, status: response.status };
  }
}

function failed(failure: TagFailure): TagResult {
  return { ok: false, failure };
}

/** The model's text out of the response envelope, or undefined when the envelope is not what we expect. */
function answerText(responseJson: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(responseJson);
  } catch {
    return undefined;
  }
  const parsed = GenerateContentResponse.safeParse(json);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.candidates[0]?.content.parts.find((part) => part.text !== undefined)?.text;
}
