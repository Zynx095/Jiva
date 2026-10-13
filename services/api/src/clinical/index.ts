import { LocalClinicalStore, type IClinicalStore } from './store';

/** Process-wide clinical store (local mode, in-memory). */
export const clinicalStore: IClinicalStore = new LocalClinicalStore();

export * from './policy';
export type { IClinicalStore, CommandResult } from './store';
