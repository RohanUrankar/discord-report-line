import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the stub saw. The body is kept as text so a test can assert on exactly what was sent. */
export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Wait this long before answering, to exercise the caller's timeout. */
  delayMs?: number;
  /** Drop the connection without answering: the caller sees a network error. */
  destroy?: boolean;
}

export type StubBehaviour = (request: StubRequest, callNumber: number) => StubResponse;

export const OK: StubResponse = { status: 200, body: 'ok' };

/** Answers each call in turn with the given statuses, then 200 forever. */
export function thenOk(...statuses: number[]): StubBehaviour {
  return (_request, callNumber) => {
    const status = statuses[callNumber];
    return status === undefined ? OK : { status };
  };
}

/** A local HTTP server standing in for Slack or Discord. Tests never call the real services. */
export class StubServer {
  public readonly requests: StubRequest[] = [];
  private behaviour: StubBehaviour = () => OK;

  private constructor(private readonly server: Server) {}

  public static async start(): Promise<StubServer> {
    const holder: { stub?: StubServer } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const stub = holder.stub;
        if (stub === undefined) {
          res.destroy();
          return;
        }
        stub.answer(
          {
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          },
          res,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const stub = new StubServer(server);
    holder.stub = stub;
    return stub;
  }

  public get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  public behave(behaviour: StubBehaviour): void {
    this.behaviour = behaviour;
  }

  /** Forget what was seen and answer 200 again. */
  public reset(): void {
    this.requests.length = 0;
    this.behaviour = () => OK;
  }

  public async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private answer(request: StubRequest, res: ServerResponse): void {
    const callNumber = this.requests.length;
    this.requests.push(request);
    const response = this.behaviour(request, callNumber);
    const send = (): void => {
      if (response.destroy === true) {
        res.socket?.destroy();
        return;
      }
      res.writeHead(response.status, response.headers);
      res.end(response.body ?? '');
    };
    if (response.delayMs === undefined) {
      send();
    } else {
      setTimeout(send, response.delayMs);
    }
  }
}
