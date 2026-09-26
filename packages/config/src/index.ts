import fs from 'fs';
import path from 'path';

function findAndLoadEnv() {
  if (typeof (process as any).loadEnvFile !== 'function') return;
  let curr = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(curr, '.env');
    if (fs.existsSync(envPath)) {
      try {
        (process as any).loadEnvFile(envPath);
        return;
      } catch {}
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
}
findAndLoadEnv();

export type EnvironmentType = 'local' | 'aws-demo' | 'production';

export interface JivaConfig {
  environment: EnvironmentType;
  isLocal: boolean;
  isAws: boolean;
  isDemo: boolean;
  port: number;
  aws: {
    region: string;
    eventBusName: string;
    dynamoTableName: string;
    s3BucketName: string;
    apiGatewayUrl?: string;
    webSocketUrl?: string;
    cognitoUserPoolId?: string;
    cognitoClientId?: string;
    bedrockModelId: string;
  };
  mapping: {
    provider: 'auto' | 'valhalla' | 'osrm' | 'mock';
    valhallaBaseUrl: string;
    osrmBaseUrl: string;
    timeoutMs: number;
  };
  googleMaps?: {
    serverApiKey?: string;
    clientApiKey?: string;
    enableLiveRouting: boolean;
  };
  auth: {
    demoAuthSecret: string;
    enableCognito: boolean;
  };
}

export function loadConfig(): JivaConfig {
  const envRaw = (process.env.ENVIRONMENT || process.env.NODE_ENV || 'local').toLowerCase();
  let environment: EnvironmentType = 'local';
  if (envRaw === 'aws-demo' || envRaw === 'aws') {
    environment = 'aws-demo';
  } else if (envRaw === 'production' || envRaw === 'prod') {
    environment = 'production';
  }

  const isLocal = environment === 'local';
  const isAws = !isLocal;
  const isDemo = process.env.DEMO_MODE !== 'false';

  return {
    environment,
    isLocal,
    isAws,
    isDemo,
    port: parseInt(process.env.PORT || '4000', 10),
    aws: {
      region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'ap-south-1',
      eventBusName: process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh',
      dynamoTableName: process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh',
      s3BucketName: process.env.S3_BUCKET_NAME || 'jiva-audit-reports',
      apiGatewayUrl: process.env.API_GATEWAY_URL,
      webSocketUrl: process.env.WEBSOCKET_URL,
      cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID,
      cognitoClientId: process.env.COGNITO_CLIENT_ID,
      bedrockModelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
    },
    mapping: {
      provider: (process.env.MAPPING_PROVIDER as any) || 'auto',
      valhallaBaseUrl: process.env.VALHALLA_BASE_URL || 'http://localhost:8002',
      osrmBaseUrl: process.env.OSRM_BASE_URL || 'http://localhost:5000',
      timeoutMs: parseInt(process.env.MAPPING_TIMEOUT_MS || '5000', 10),
    },
    googleMaps: {
      serverApiKey: process.env.GOOGLE_MAPS_SERVER_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY,
      clientApiKey: process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_CLIENT_KEY,
      enableLiveRouting: false,
    },
    auth: {
      demoAuthSecret: process.env.DEMO_AUTH_SECRET || 'jiva-dev-secret-key-12345',
      enableCognito: process.env.ENABLE_COGNITO === 'true',
    },
  };
}

export const config = loadConfig();
