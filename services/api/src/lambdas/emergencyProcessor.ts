import { createAwsDeps } from './core/awsWiring';
import { createEmergencyHandler } from './core/emergencyCore';

// Thin AWS wiring. All behaviour lives in core/emergencyCore.ts (shared with tests / local rules).
export const handler = createEmergencyHandler(createAwsDeps());
