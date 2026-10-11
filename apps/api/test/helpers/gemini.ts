import type { StubResponse } from './stubServer.js';

/** A recognisable fake key: tests assert it never shows up in a URL, a log line, a response or a database row. */
export const GEMINI_TEST_KEY = 'SENTINEL-GEMINI-KEY-do-not-leak';

/** What Gemini's generateContent returns when the model answered `modelText`. */
export function geminiEnvelope(modelText: string): string {
  return JSON.stringify({
    candidates: [
      { content: { role: 'model', parts: [{ text: modelText }] }, finishReason: 'STOP' },
    ],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 4, totalTokenCount: 44 },
    modelVersion: 'stub',
  });
}

/** A 200 whose model text is `{"tag": <tag>}`. Pass any string to try an out-of-enum answer. */
export function geminiTag(tag: string): StubResponse {
  return { status: 200, body: geminiEnvelope(JSON.stringify({ tag })) };
}
