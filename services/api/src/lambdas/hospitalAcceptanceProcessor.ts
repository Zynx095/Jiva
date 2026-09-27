import { createAwsDeps } from './core/awsWiring';
import { createHospitalHandler } from './core/hospitalCore';

// Thin AWS wiring. All behaviour lives in core/hospitalCore.ts (shared transition rules).
export const handler = createHospitalHandler(createAwsDeps());
