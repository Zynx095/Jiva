import { config } from '@jiva/config';
import { IEventBus, LocalEventBus, AwsEventBridgeBus } from './eventBus';
import { IStateStore, LocalStateStore, DynamoStateStore } from './stateStore';
import { MappingProvider, createMappingProvider } from '@jiva/mapping';
import { AIProvider, MockAIProvider, BedrockAIProvider, CachedAIProvider } from '@jiva/intelligence';
import { IRealtimeAdapter, LocalSocketIoAdapter, AwsWebSocketAdapter } from '@jiva/realtime';
import { Logger } from './observability/logger';
import { MetricsCollector } from './observability/metrics';

export interface InfrastructureBundle {
  eventBus: IEventBus;
  stateStore: IStateStore;
  mappingProvider: MappingProvider;
  aiProvider: AIProvider;
  realtimeAdapter: IRealtimeAdapter;
  logger: Logger;
  metrics: MetricsCollector;
}

export function createInfrastructure(ioInstance?: any): InfrastructureBundle {
  const logger = new Logger('JivaInfrastructure');
  const metrics = new MetricsCollector(config.isAws, config.aws.region);

  logger.info(`Initializing JIVA Infrastructure for environment: ${config.environment}`);

  // 1. EventBus
  let eventBus: IEventBus;
  if (config.isAws) {
    logger.info(`Using AWS EventBridge Bus: ${config.aws.eventBusName}`);
    eventBus = new AwsEventBridgeBus({
      eventBusName: config.aws.eventBusName,
      region: config.aws.region,
    });
  } else {
    logger.info('Using Local in-memory EventBus');
    eventBus = new LocalEventBus();
  }

  // 2. StateStore
  let stateStore: IStateStore;
  if (config.isAws) {
    logger.info(`Using DynamoDB State Store: ${config.aws.dynamoTableName}`);
    stateStore = new DynamoStateStore({
      tableName: config.aws.dynamoTableName,
      region: config.aws.region,
    });
  } else {
    logger.info('Using Local in-memory State Store');
    stateStore = new LocalStateStore();
  }

  // 3. MappingProvider (Valhalla -> OSRM -> Mock fallback)
  logger.info(`Initializing MappingProvider (Mode: ${config.mapping.provider}, Valhalla: ${config.mapping.valhallaBaseUrl}, OSRM: ${config.mapping.osrmBaseUrl})`);
  const mappingProvider: MappingProvider = createMappingProvider(
    {
      provider: config.mapping.provider,
      valhallaBaseUrl: config.mapping.valhallaBaseUrl,
      osrmBaseUrl: config.mapping.osrmBaseUrl,
      timeoutMs: config.mapping.timeoutMs,
    },
    {
      warn: (msg, meta) => logger.warn(msg, meta),
      info: (msg, meta) => logger.info(msg, meta),
    }
  );

  // 4. AIProvider with Caching
  let baseAi: AIProvider;
  if (config.isAws || process.env.USE_BEDROCK === 'true') {
    logger.info(`Using BedrockAIProvider (Model: ${config.aws.bedrockModelId})`);
    baseAi = new BedrockAIProvider(config.aws.region);
  } else {
    logger.info('Using MockAIProvider (Deterministic clinical handoffs & anomaly explanations)');
    baseAi = new MockAIProvider();
  }
  const aiProvider = new CachedAIProvider(baseAi);

  // 5. RealtimeAdapter
  let realtimeAdapter: IRealtimeAdapter;
  if (config.isAws && config.aws.webSocketUrl) {
    logger.info(`Using AwsWebSocketAdapter (${config.aws.webSocketUrl})`);
    realtimeAdapter = new AwsWebSocketAdapter(config.aws.webSocketUrl, {
      listConnections: async () => [],
      removeConnection: async () => {},
    }, config.aws.region);
  } else {
    logger.info('Using LocalSocketIoAdapter');
    realtimeAdapter = new LocalSocketIoAdapter(ioInstance);
  }

  return {
    eventBus,
    stateStore,
    mappingProvider,
    aiProvider,
    realtimeAdapter,
    logger,
    metrics,
  };
}
