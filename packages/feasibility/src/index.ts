/**
 * @jiva/feasibility — deterministic Care Feasibility Engine.
 * Pure: no I/O, no wall clock, no mapping provider, no AI. See docs/claude-01-care-feasibility-design.md.
 */
export * from './policy';
export * from './capabilityMap';
export * from './canonical';
export * from './engine';
export * from './trace';
export { isOperationalGrade, responseUsability } from './rules';
export { isUnknownFact } from './factors';
