import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  GetCommand, 
  PutCommand, 
  QueryCommand, 
  ScanCommand 
} from '@aws-sdk/lib-dynamodb';
import { PatientState, HospitalState, AmbulanceState, CareRequirement, HospitalAvailabilityResponse } from '@jiva/domain-models';
import { AnyEvent } from '@jiva/event-schema';
import { IStateStore, RecordEventResult } from './types';
import {
  CaseHospitalRecord, rebuildFromEvents, shouldAcceptCancellation, shouldAcceptNewestAccepting,
  shouldAcceptRequest, shouldAcceptRequirement, shouldAcceptResponse, shouldAcceptWideUnavailable,
} from './materializedAcceptance';

export interface DynamoStateStoreOptions {
  tableName: string;
  region: string;
}

/** Sorts before any real ISO timestamp: hospitals with no confirmed acceptance yet. */
export const HOSPITAL_WRITE_GUARD_FLOOR = '1970-01-01T00:00:00.000Z';

export class DynamoStateStore implements IStateStore {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(options: DynamoStateStoreOptions) {
    this.tableName = options.tableName;
    const client = new DynamoDBClient({ region: options.region });
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  // --- Patient State ---
  async getPatient(patientId: string): Promise<PatientState | undefined> {
    const res = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        PK: `PATIENT#${patientId}`,
        SK: 'STATE#CURRENT',
      },
    }));
    return res.Item?.data as PatientState | undefined;
  }

  async setPatient(patient: PatientState): Promise<void> {
    // Conditional write for event ordering: only update if item doesn't exist OR incoming lastUpdated >= existing
    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `PATIENT#${patient.patientId}`,
          SK: 'STATE#CURRENT',
          EntityType: 'PATIENT',
          Id: patient.patientId,
          lastUpdated: patient.lastUpdated,
          data: patient,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #lastUpdated <= :newUpdated',
        ExpressionAttributeNames: {
          '#lastUpdated': 'lastUpdated',
        },
        ExpressionAttributeValues: {
          ':newUpdated': patient.lastUpdated,
        },
      }));
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.warn(`[DynamoStateStore] Ignored out-of-order patient update for ${patient.patientId}`);
      } else {
        throw err;
      }
    }
  }

  async listPatients(): Promise<PatientState[]> {
    const res = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'EntityType = :type AND SK = :sk',
      ExpressionAttributeValues: {
        ':type': 'PATIENT',
        ':sk': 'STATE#CURRENT',
      },
    }));
    return (res.Items || []).map(i => i.data);
  }

  // --- Hospital State ---
  async getHospital(hospitalId: string): Promise<HospitalState | undefined> {
    const res = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        PK: `HOSPITAL#${hospitalId}`,
        SK: 'STATE#CURRENT',
      },
    }));
    return res.Item?.data as HospitalState | undefined;
  }

  async setHospital(hospital: HospitalState): Promise<void> {
    // Ordering guard for hospital writes. It must reflect ONLY hospital-confirmed acceptance time:
    // a capacity update (which leaves lastConfirmedAt untouched) must not stamp "now" here, or a later-
    // processed acceptance with an earlier respondedAt would fail the condition and be silently dropped.
    const lastConfirmedAt = hospital.operationalState?.lastConfirmedAt || HOSPITAL_WRITE_GUARD_FLOOR;
    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `HOSPITAL#${hospital.hospitalId}`,
          SK: 'STATE#CURRENT',
          EntityType: 'HOSPITAL',
          Id: hospital.hospitalId,
          acceptance: hospital.operationalState?.acceptance,
          emergencyStatus: hospital.operationalState?.emergency,
          lastConfirmedAt,
          data: hospital,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #confirmed <= :newConfirmed',
        ExpressionAttributeNames: {
          '#confirmed': 'lastConfirmedAt',
        },
        ExpressionAttributeValues: {
          ':newConfirmed': lastConfirmedAt,
        },
      }));
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.warn(`[DynamoStateStore] Ignored out-of-order hospital state update for ${hospital.hospitalId}`);
      } else {
        throw err;
      }
    }
  }

  async listHospitals(): Promise<HospitalState[]> {
    const res = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'EntityType = :type AND SK = :sk',
      ExpressionAttributeValues: {
        ':type': 'HOSPITAL',
        ':sk': 'STATE#CURRENT',
      },
    }));
    return (res.Items || []).map(i => i.data);
  }

  // --- Ambulance State ---
  async getAmbulance(ambulanceId: string): Promise<AmbulanceState | undefined> {
    const res = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        PK: `AMBULANCE#${ambulanceId}`,
        SK: 'STATE#CURRENT',
      },
    }));
    return res.Item?.data as AmbulanceState | undefined;
  }

  async setAmbulance(ambulance: AmbulanceState): Promise<void> {
    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `AMBULANCE#${ambulance.ambulanceId}`,
          SK: 'STATE#CURRENT',
          EntityType: 'AMBULANCE',
          Id: ambulance.ambulanceId,
          lastUpdated: ambulance.lastUpdated,
          data: ambulance,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #lastUpdated <= :newUpdated',
        ExpressionAttributeNames: {
          '#lastUpdated': 'lastUpdated',
        },
        ExpressionAttributeValues: {
          ':newUpdated': ambulance.lastUpdated,
        },
      }));
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.warn(`[DynamoStateStore] Ignored out-of-order ambulance update for ${ambulance.ambulanceId}`);
      } else {
        throw err;
      }
    }
  }

  async listAmbulances(): Promise<AmbulanceState[]> {
    const res = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'EntityType = :type AND SK = :sk',
      ExpressionAttributeValues: {
        ':type': 'AMBULANCE',
        ':sk': 'STATE#CURRENT',
      },
    }));
    return (res.Items || []).map(i => i.data);
  }

  // --- Event History with Idempotency Guard ---
  async recordEvent(event: AnyEvent): Promise<RecordEventResult> {
    const correlationId = (event as any).correlationId || (event as any).payload?.caseId || (event as any).patientId || 'GENERAL';
    const eventTime = event.timestamp || new Date().toISOString();

    // 1. Idempotency item: conditional write on eventId
    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `EVENT#${event.eventId}`,
          SK: 'METADATA',
          EntityType: 'EVENT_GUARD',
          eventId: event.eventId,
          eventType: event.eventType,
          correlationId,
          createdAt: eventTime,
          ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 3600), // 7 days TTL
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Event was already processed!
        console.warn(`[DynamoStateStore] Idempotency guard triggered: duplicate eventId ${event.eventId}`);
        return { isDuplicate: true, eventId: event.eventId };
      }
      throw err;
    }

    // 2. Queryable Event History item
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `CASE#${correlationId}`,
        SK: `EVENT#${eventTime}#${event.eventId}`,
        EntityType: 'EVENT_HISTORY',
        GSI1PK: 'EVENTS#ALL',
        GSI1SK: `${eventTime}#${event.eventId}`,
        eventId: event.eventId,
        eventType: event.eventType,
        correlationId,
        timestamp: eventTime,
        data: event,
      },
    }));

    return { isDuplicate: false, eventId: event.eventId };
  }

  /**
   * All history for a case. A DynamoDB Query returns at most 1 MB per page and the sort key is
   * ascending by time, so an unpaginated read silently drops the NEWEST events (the acceptance
   * responses that matter most). This follows LastEvaluatedKey to the end. A runaway partition is an
   * error, never a silent truncation.
   */
  async queryEventsByCase(caseId: string): Promise<AnyEvent[]> {
    const MAX_PAGES = 100;
    const items: AnyEvent[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `CASE#${caseId}`,
          ':skPrefix': 'EVENT#',
        },
        ExclusiveStartKey: startKey,
        // A response written a moment ago must be visible (a base-table Query may be strongly consistent; a GSI may not).
        ConsistentRead: true,
      }));
      for (const i of res.Items || []) items.push(i.data);
      startKey = res.LastEvaluatedKey;
      if (!startKey) return items;
    }
    throw new Error(`Case ${caseId} history exceeds ${MAX_PAGES} pages; refusing to return a truncated history`);
  }

  async listRecentEvents(limit: number = 100): Promise<AnyEvent[]> {
    try {
      const res = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'EVENTS#ALL',
        },
        ScanIndexForward: false, // Descending order
        Limit: limit,
      }));
      return (res.Items || []).map(i => i.data);
    } catch (err) {
      // GSI1 unavailable (not yet provisioned, throttled, ...). A Scan applies its Limit to items
      // EXAMINED before FilterExpression runs, so "Limit: N" on a Scan can silently return FEWER
      // than N matching EVENT_HISTORY items -- or none -- while claiming to be "the recent events".
      // That previously let a real hospital.acceptance.received UNAVAILABLE go unseen and a hospital
      // read as ELIGIBLE that was not. There is no way to guarantee completeness from a bounded Scan
      // without knowing the table's item-type distribution, so this now FAILS CLOSED: no silent
      // partial result, an observable error, and the caller (loadLedger / the shadow) treats the
      // evaluation as unavailable rather than substituting a guess.
      console.error(`[DynamoStateStore] GSI1 (EVENTS#ALL) unavailable and no safe fallback exists; refusing to Scan a possibly-incomplete result: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(`listRecentEvents: GSI1 unavailable and Scan cannot guarantee completeness (limit=${limit})`);
    }
  }

  async preloadData(): Promise<void> {
    // In AWS mode, master data is either seeded via DynamoDB batch write or already populated
    console.log('[DynamoStateStore] Connected to persistent DynamoDB state store.');
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.docClient.send(new ScanCommand({
        TableName: this.tableName,
        Limit: 1,
      }));
      return true;
    } catch {
      return false;
    }
  }

  getProviderName(): string {
    return 'DynamoStateStore';
  }

  // ---- Materialized acceptance/requirement indexes (see materializedAcceptance.ts) ----

  async getAcceptanceRecord(caseId: string, hospitalId: string): Promise<CaseHospitalRecord | undefined> {
    const [reqRes, respRes] = await Promise.all([
      this.docClient.send(new GetCommand({ TableName: this.tableName, Key: { PK: `ACC#${caseId}#${hospitalId}`, SK: 'REQUEST' }, ConsistentRead: true })),
      this.docClient.send(new GetCommand({ TableName: this.tableName, Key: { PK: `ACC#${caseId}#${hospitalId}`, SK: 'RESPONSE' }, ConsistentRead: true })),
    ]);
    const rec: CaseHospitalRecord = {};
    if (reqRes.Item) rec.request = { requestId: reqRes.Item.requestId, requestedAt: reqRes.Item.requestedAt, expiresAt: reqRes.Item.expiresAt, ...(reqRes.Item.cancelledAt ? { cancelledAt: reqRes.Item.cancelledAt } : {}) };
    if (respRes.Item) rec.response = respRes.Item.data;
    return rec.request || rec.response ? rec : undefined;
  }

  async putAcceptanceRequest(caseId: string, hospitalId: string, request: { requestId: string; requestedAt: string; expiresAt: string }): Promise<void> {
    const existing = (await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: { PK: `ACC#${caseId}#${hospitalId}`, SK: 'REQUEST' }, ConsistentRead: true }))).Item as { requestId: string; requestedAt: string } | undefined;
    if (!shouldAcceptRequest(existing as never, request)) return;
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { PK: `ACC#${caseId}#${hospitalId}`, SK: 'REQUEST', EntityType: 'ACCEPTANCE_REQUEST', ...request },
    }));
  }

  async putAcceptanceResponse(caseId: string, hospitalId: string, response: HospitalAvailabilityResponse): Promise<'APPLIED' | 'STALE' | 'DUPLICATE'> {
    const key = { PK: `ACC#${caseId}#${hospitalId}`, SK: 'RESPONSE' };
    const existing = (await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))).Item?.data as HospitalAvailabilityResponse | undefined;
    if (existing?.responseId === response.responseId) return 'DUPLICATE';
    if (!shouldAcceptResponse(existing, response)) return 'STALE';
    await this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { ...key, EntityType: 'ACCEPTANCE_RESPONSE', data: response } }));
    const wideKey = { PK: `HOSPWIDE#${hospitalId}`, SK: 'RECORD' };
    const wide = (await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: wideKey, ConsistentRead: true }))).Item as { response?: HospitalAvailabilityResponse; newestAcceptingAt?: string } | undefined;
    const next = { ...(wide || {}) };
    let changed = false;
    if (shouldAcceptWideUnavailable(next.response, response)) { next.response = response; changed = true; }
    if (shouldAcceptNewestAccepting(next.newestAcceptingAt, response)) { next.newestAcceptingAt = response.respondedAt; changed = true; }
    if (changed) await this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { ...wideKey, EntityType: 'HOSPITAL_WIDE_ACCEPTANCE', ...next } }));
    return 'APPLIED';
  }

  async putAcceptanceCancellation(caseId: string, hospitalId: string, requestId: string, cancelledAt: string): Promise<void> {
    const key = { PK: `ACC#${caseId}#${hospitalId}`, SK: 'REQUEST' };
    const existing = (await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))).Item as { requestId: string; requestedAt: string; expiresAt: string; cancelledAt?: string } | undefined;
    if (!existing || existing.requestId !== requestId) return;
    if (!shouldAcceptCancellation(existing.cancelledAt, cancelledAt)) return;
    await this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { ...key, EntityType: 'ACCEPTANCE_REQUEST', ...existing, cancelledAt } }));
  }

  async getHospitalWideUnavailable(hospitalId: string): Promise<{ response?: HospitalAvailabilityResponse; newestAcceptingAt?: string } | undefined> {
    const res = await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: { PK: `HOSPWIDE#${hospitalId}`, SK: 'RECORD' }, ConsistentRead: true }));
    return res.Item ? { response: res.Item.response, newestAcceptingAt: res.Item.newestAcceptingAt } : undefined;
  }

  async getLatestRequirement(caseId: string): Promise<CareRequirement | undefined> {
    const res = await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: { PK: `REQ#${caseId}`, SK: 'LATEST' }, ConsistentRead: true }));
    return res.Item?.data;
  }

  async putLatestRequirement(caseId: string, requirement: CareRequirement): Promise<void> {
    const key = { PK: `REQ#${caseId}`, SK: 'LATEST' };
    const existing = (await this.docClient.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))).Item?.data as CareRequirement | undefined;
    if (!shouldAcceptRequirement(existing, requirement)) return;
    await this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { ...key, EntityType: 'CARE_REQUIREMENT', data: requirement } }));
  }

  /** Maintenance-path: complete, paginated scan of the whole table's EVENT_HISTORY items (no GSI, no Limit-before-filter). */
  async listAllEvents(): Promise<AnyEvent[]> {
    const items: AnyEvent[] = [];
    let startKey: Record<string, unknown> | undefined;
    const MAX_PAGES = 100000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.docClient.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'EntityType = :type',
        ExpressionAttributeValues: { ':type': 'EVENT_HISTORY' },
        ExclusiveStartKey: startKey,
      }));
      for (const i of res.Items || []) items.push(i.data);
      startKey = res.LastEvaluatedKey;
      if (!startKey) return items;
    }
    throw new Error(`listAllEvents: table exceeds ${MAX_PAGES} scan pages; refusing to return a truncated history`);
  }

  async rebuildAcceptanceRecords(): Promise<{ casesHospitalPairs: number; hospitals: number }> {
    const events = await this.listAllEvents();
    const { byKey, wideByHospital } = rebuildFromEvents(events);
    await Promise.all([
      ...[...byKey.entries()].flatMap(([key, rec]) => {
        const [caseId, hospitalId] = key.split('|');
        const writes: Promise<unknown>[] = [];
        if (rec.request) writes.push(this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { PK: `ACC#${caseId}#${hospitalId}`, SK: 'REQUEST', EntityType: 'ACCEPTANCE_REQUEST', ...rec.request } })));
        if (rec.response) writes.push(this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { PK: `ACC#${caseId}#${hospitalId}`, SK: 'RESPONSE', EntityType: 'ACCEPTANCE_RESPONSE', data: rec.response } })));
        return writes;
      }),
      ...[...wideByHospital.entries()].map(([hospitalId, wide]) =>
        this.docClient.send(new PutCommand({ TableName: this.tableName, Item: { PK: `HOSPWIDE#${hospitalId}`, SK: 'RECORD', EntityType: 'HOSPITAL_WIDE_ACCEPTANCE', ...wide } }))),
    ]);
    return { casesHospitalPairs: byKey.size, hospitals: wideByHospital.size };
  }
}
