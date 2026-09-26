export interface StructuredLog {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  service: string;
  message: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
  eventType?: string;
  latencyMs?: number;
  metadata?: Record<string, any>;
  error?: string;
}

export class Logger {
  private service: string;

  constructor(service: string) {
    this.service = service;
  }

  private log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, context?: Partial<StructuredLog>) {
    const entry: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      eventId: context?.eventId,
      correlationId: context?.correlationId,
      causationId: context?.causationId,
      eventType: context?.eventType,
      latencyMs: context?.latencyMs,
      metadata: context?.metadata,
      error: context?.error,
    };

    // Output JSON for CloudWatch Logs ingestion
    console.log(JSON.stringify(entry));
  }

  info(message: string, context?: Partial<StructuredLog>) {
    this.log('INFO', message, context);
  }

  warn(message: string, context?: Partial<StructuredLog>) {
    this.log('WARN', message, context);
  }

  error(message: string, error?: any, context?: Partial<StructuredLog>) {
    this.log('ERROR', message, {
      ...context,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
  }

  debug(message: string, context?: Partial<StructuredLog>) {
    this.log('DEBUG', message, context);
  }
}
