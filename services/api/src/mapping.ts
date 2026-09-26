import { MappingProvider, createMappingProvider } from '@jiva/mapping';

// Valhalla -> OSRM -> Mock fallback chain (mode selected by MAPPING_PROVIDER).
export const mappingProvider: MappingProvider = createMappingProvider();
