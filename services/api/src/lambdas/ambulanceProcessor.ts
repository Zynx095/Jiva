import { createAwsDeps } from './core/awsWiring';
import { createAmbulanceHandler } from './core/ambulanceCore';

// Thin AWS wiring. All behaviour lives in core/ambulanceCore.ts.
export const handler = createAmbulanceHandler(createAwsDeps());
