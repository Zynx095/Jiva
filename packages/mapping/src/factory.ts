import { MappingProvider } from './providers/MappingProvider';
import { ValhallaMappingProvider } from './providers/ValhallaMappingProvider';
import { OSRMMappingProvider } from './providers/OSRMMappingProvider';
import { MockMappingProvider } from './providers/MockMappingProvider';
import { FallbackMappingProvider, FallbackLogger } from './providers/FallbackMappingProvider';
import { MappingConfig } from './types';

export function createMappingProvider(
  config?: MappingConfig,
  logger?: FallbackLogger
): MappingProvider {
  const providerMode = (
    config?.provider ||
    process.env.MAPPING_PROVIDER ||
    'auto'
  ).toLowerCase();

  const valhallaUrl = config?.valhallaBaseUrl || process.env.VALHALLA_BASE_URL || 'http://localhost:8002';
  const osrmUrl = config?.osrmBaseUrl || process.env.OSRM_BASE_URL || 'http://localhost:5000';
  const timeoutMs = config?.timeoutMs || 5000;

  switch (providerMode) {
    case 'valhalla':
      return new ValhallaMappingProvider({ baseUrl: valhallaUrl, timeoutMs });

    case 'osrm':
      return new OSRMMappingProvider({ baseUrl: osrmUrl, timeoutMs });

    case 'mock':
      return new MockMappingProvider();

    case 'auto':
    default: {
      const valhalla = new ValhallaMappingProvider({ baseUrl: valhallaUrl, timeoutMs });
      const osrm = new OSRMMappingProvider({ baseUrl: osrmUrl, timeoutMs });
      const mock = new MockMappingProvider();
      return new FallbackMappingProvider(valhalla, osrm, mock, logger);
    }
  }
}
