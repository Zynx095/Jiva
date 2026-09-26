import { PatientState, HospitalState, AmbulanceState } from '@jiva/domain-models';
import { IStateStore, LocalStateStore, DynamoStateStore } from './infrastructure/stateStore';
import { config } from '@jiva/config';

// Active store instance
export const localStoreInstance = new LocalStateStore();

export const stateStore: IStateStore = config.isAws
  ? new DynamoStateStore({
      tableName: config.aws.dynamoTableName,
      region: config.aws.region,
    })
  : localStoreInstance;

// Expose synchronous maps for existing engines in local mode
export const patientsStore: Map<string, PatientState> = localStoreInstance.patientsStore;
export const hospitalsStore: Map<string, HospitalState> = localStoreInstance.hospitalsStore;
export const ambulancesStore: Map<string, AmbulanceState> = localStoreInstance.ambulancesStore;

export async function preloadData(): Promise<void> {
  await stateStore.preloadData();
}

export type { IStateStore };
