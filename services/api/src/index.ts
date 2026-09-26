import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from './eventBus';
import {
  initializeStateEngines, mappingProvider, resetEngines, getEpoch,
  hasOutstandingRequest, outstandingRequestsForHospital,
} from './stateEngines';
import { initializeIntelligenceEngine, resetIntelligence, getAiStatus } from './intelligenceEngine';
import { preloadData, stateStore, localStoreInstance } from './stateStore';
import { config } from '@jiva/config';
import { DemoAuthProvider, CognitoAuthProvider, AuthContext } from '@jiva/auth';
import { LocalSocketIoAdapter } from '@jiva/realtime';
import { AnyEvent, AnyEventSchema } from '@jiva/event-schema';
import {
  authorizeEventSubmission, canReadCase, canReceiveEvent,
  filterAmbulances, filterPatients, sanitizeHospitals,
} from './authorization';

// Last-resort guard: a bug in any async path must be logged, never kill the API.
process.on('unhandledRejection', (reason) => {
  console.error('[API] Unhandled rejection (contained):', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[API] Uncaught exception (contained):', err.message);
});

const ready = preloadData().catch(err => console.error('[StateStore] Preload error:', err.message));

const allowedOrigins = (process.env.CORS_ORIGINS ||
  'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,' +
  'http://localhost:4173,http://localhost:4174,http://localhost:4175,http://localhost:4176')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '100kb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: allowedOrigins } });
const realtimeAdapter = new LocalSocketIoAdapter(io);

initializeStateEngines();
initializeIntelligenceEngine();

// Every event on the bus (external and system-generated) goes into the audit ledger.
eventBus.on('*', (event: AnyEvent) => {
  if (event.source?.type === 'system' || event.eventType.startsWith('ai.')) {
    localStoreInstance.appendHistory(event);
  }
});

// ------------------------------------------------------------------ auth

interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Local mode uses DEMO-ONLY persona authentication (see @jiva/auth demoAuth.ts).
 * With ENABLE_COGNITO=true, claims forwarded by API Gateway's Cognito authorizer are used.
 */
function authenticate(headers: Record<string, string | string[] | undefined>): AuthContext | undefined {
  if (config.auth.enableCognito && typeof headers['x-cognito-claims'] === 'string') {
    try {
      const result = CognitoAuthProvider.parseClaims(JSON.parse(headers['x-cognito-claims']));
      if (result.authenticated) return result.context;
    } catch { /* fall through */ }
  }
  const demo = DemoAuthProvider.authenticate(headers);
  return demo.authenticated ? demo.context : undefined;
}

const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const auth = authenticate(req.headers);
  if (!auth) return res.status(401).json({ error: 'unauthenticated', message: 'Provide a demo persona via x-jiva-demo-user (demo mode) or a Cognito token.' });
  req.auth = auth;
  next();
};

const requireRole = (...roles: AuthContext['role'][]) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };

// ------------------------------------------------------------------ public

app.get('/api/health', async (_req, res) => {
  const eventBusHealthy = await eventBus.isHealthy();
  const dbHealthy = await stateStore.isHealthy();
  const realtimeHealthy = realtimeAdapter.isHealthy();
  const mappingStatus = (mappingProvider as any).getStatus
    ? (mappingProvider as any).getStatus()
    : { mode: mappingProvider.name, activeProvider: mappingProvider.name };
  const isAllHealthy = eventBusHealthy && dbHealthy && realtimeHealthy;

  res.status(isAllHealthy ? 200 : 503).json({
    status: isAllHealthy ? 'HEALTHY' : 'DEGRADED',
    environment: config.environment,
    demoAuth: true,
    timestamp: new Date().toISOString(),
    components: {
      api: { status: 'HEALTHY', port: config.port },
      eventBus: { status: eventBusHealthy ? 'HEALTHY' : 'UNAVAILABLE', provider: eventBus.getProviderName() },
      database: { status: dbHealthy ? 'HEALTHY' : 'UNAVAILABLE', provider: stateStore.getProviderName() },
      realtime: { status: realtimeHealthy ? 'CONNECTED' : 'DISCONNECTED', provider: 'Socket.IO', activeConnections: realtimeAdapter.getConnectionCount() },
      mapping: {
        status: 'AVAILABLE',
        provider: mappingStatus.activeProvider,
        synthetic: mappingStatus.activeProvider === 'mock',
        ...mappingStatus,
      },
      ai: { status: 'AVAILABLE', ...getAiStatus() },
    },
  });
});

app.use('/api', requireAuth);

app.get('/api/whoami', (req: AuthenticatedRequest, res) => res.json(req.auth));

// ------------------------------------------------------------------ reads

app.get('/api/patients', async (req: AuthenticatedRequest, res) => {
  res.json(filterPatients(req.auth!, await stateStore.listPatients()));
});

app.get('/api/hospitals', async (req: AuthenticatedRequest, res) => {
  res.json(sanitizeHospitals(req.auth!, await stateStore.listHospitals()));
});

app.get('/api/ambulances', async (req: AuthenticatedRequest, res) => {
  res.json(filterAmbulances(req.auth!, await stateStore.listAmbulances()));
});

app.get('/api/hospitals/:id/requests', (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const allowed = auth.role === 'ADMIN' || auth.role === 'MANAGEMENT' || (auth.role === 'HOSPITAL' && auth.hospitalId === String(req.params.id));
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  res.json(outstandingRequestsForHospital(String(req.params.id)));
});

app.get('/api/events/history', requireRole('MANAGEMENT', 'ADMIN'), async (req, res) => {
  const raw = parseInt(String(req.query.limit ?? '100'), 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 100;
  res.json(await stateStore.listRecentEvents(limit));
});

app.get('/api/cases/:id/timeline', async (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  if (!canReadCase(auth, String(req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const events = await stateStore.queryEventsByCase(String(req.params.id));
  res.json(events.filter(e => canReceiveEvent(auth, e)));
});

// ------------------------------------------------------------------ writes

app.post('/api/events', async (req: AuthenticatedRequest, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'invalid_body', message: 'Expected a JSON event object.' });
  }
  if (!body.eventId || !body.eventType) {
    return res.status(400).json({ error: 'invalid_event', message: 'eventId and eventType are required.' });
  }

  const parsed = AnyEventSchema.safeParse(body);
  if (!parsed.success) {
    const unknownType = parsed.error.issues.some(i => i.code === 'invalid_union_discriminator');
    return res.status(400).json({
      error: unknownType ? 'unknown_event_type' : 'validation_failed',
      issues: parsed.error.issues.slice(0, 10).map(i => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const event = parsed.data as AnyEvent;

  if (Date.parse(event.timestamp) > Date.now() + 60_000) {
    return res.status(400).json({ error: 'validation_failed', issues: [{ path: 'timestamp', message: 'Timestamp is in the future' }] });
  }

  const denial = authorizeEventSubmission(req.auth!, event);
  if (denial) return res.status(403).json({ error: 'forbidden', message: denial });

  // Acceptance protocol: a hospital may only answer a request it actually received.
  if (event.eventType === 'hospital.acceptance.received' &&
      !hasOutstandingRequest(event.payload.caseId, event.payload.hospitalId)) {
    return res.status(409).json({ error: 'no_outstanding_request', message: 'No open acceptance request for this case and hospital.' });
  }

  const recordResult = await stateStore.recordEvent(event);
  if (recordResult.isDuplicate) {
    return res.status(200).json({ status: 'duplicate_ignored', eventId: event.eventId });
  }

  await eventBus.publish(event);
  res.status(202).json({ status: 'accepted', eventId: event.eventId });
});

app.post('/api/demo/reset', requireRole('ADMIN'), async (req: AuthenticatedRequest, res) => {
  resetEngines();
  resetIntelligence();
  await localStoreInstance.reset();
  await eventBus.publish({
    eventId: uuidv4(),
    eventType: 'demo.reset',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'demo-control' },
    version: '1.0',
    payload: { resetBy: req.auth!.userId, epoch: getEpoch() },
  } as AnyEvent);
  res.json({ status: 'reset', epoch: getEpoch() });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Malformed JSON and any other error: structured response, no stack traces.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  console.error('[API] Request error:', err?.message);
  res.status(500).json({ error: 'internal_error' });
});

// ------------------------------------------------------------------ realtime

io.use((socket, next) => {
  const handshake = socket.handshake.auth || {};
  const auth = handshake.demoUser
    ? DemoAuthProvider.resolvePersona(handshake.demoUser).context
    : authenticate(socket.handshake.headers as Record<string, string>);
  if (!auth) return next(new Error('unauthenticated'));
  socket.data.auth = auth;
  next();
});

io.on('connection', (socket) => {
  const auth: AuthContext = socket.data.auth;
  console.log(`[Socket] ${auth.role} ${auth.userId} connected (${socket.id})`);
  const onEvent = (event: AnyEvent) => {
    if (canReceiveEvent(auth, event)) socket.emit('event', event);
  };
  eventBus.on('*', onEvent);
  socket.on('disconnect', () => eventBus.off('*', onEvent));
});

ready.then(() => {
  httpServer.listen(config.port, () => {
    console.log(`[API] Server running on http://localhost:${config.port} in ${config.environment.toUpperCase()} mode (DEMO AUTH)`);
  });
});
