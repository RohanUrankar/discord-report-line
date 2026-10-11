import express, { type Express } from 'express';

import type { InteractionHandler } from '../app/interactions.js';
import type { Logger } from '../ports/logger.js';
import {
  contextOf,
  errorHandler,
  notFoundHandler,
  rawInteractionBody,
  requestContext,
} from './middleware.js';

export interface ServerDeps {
  controller: InteractionHandler;
  logger: Logger;
}

/**
 * Builds the Express app without listening, so tests can drive it with Supertest (backend-guidelines).
 * This is the composition point for the request path (DESIGN §8.2).
 *
 * Body-parser rule (CLAUDE.md): the raw parser is mounted on `/interactions` only. No global JSON parser
 * exists yet; when the dashboard API adds one it must be mounted on `/api` after this route.
 */
export function createServer({ controller, logger }: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(logger));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/interactions', rawInteractionBody(), async (req, res) => {
    const { log } = contextOf(req, logger);
    const result = await controller.handle(
      {
        timestamp: req.header('x-signature-timestamp'),
        signature: req.header('x-signature-ed25519'),
        // Without a matching content type the raw parser leaves no Buffer; the verifier then rejects it.
        rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
      },
      log,
    );
    if (result.status === 200) {
      res.status(200).json(result.body);
      return;
    }
    res.status(result.status).end();
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
