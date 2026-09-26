import { z } from 'zod';

export const EventMetadataSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  sourceType: z.string(),
  freshnessSeconds: z.number().optional(),
});

export const EventSourceSchema = z.object({
  type: z.enum(['hospital', 'ambulance', 'patient', 'system', 'clinician', 'laboratory']),
  id: z.string(),
});

export const BaseEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  timestamp: z.string().datetime(),
  source: EventSourceSchema,
  patientId: z.string().optional(),
  correlationId: z.string().uuid().optional(),
  causationId: z.string().uuid().optional(),
  version: z.string().default('1.0'),
  metadata: EventMetadataSchema.optional(),
});

export type EventMetadata = z.infer<typeof EventMetadataSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type BaseEvent = z.infer<typeof BaseEventSchema>;
