/**
 * The slice of a structured logger that `app/` needs. pino satisfies it; `app/` never imports pino.
 * Messages are stable event names (`interaction.signature_rejected`); data goes in the fields object.
 */
export interface Logger {
  info(fields: object, event: string): void;
  warn(fields: object, event: string): void;
  error(fields: object, event: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
