import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  GetCommand, 
  PutCommand, 
  QueryCommand, 
  ScanCommand 
} from '@aws-sdk/lib-dynamodb';
import { PatientState, HospitalState, AmbulanceState } from '@jiva/domain-models';
import { AnyEvent } from '@jiva/event-schema';
import { IStateStore, RecordEventResult } from './types';

export interface DynamoStateStoreOptions {
  tableName: string;
  region: string;
}

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
    const lastConfirmedAt = hospital.operationalState?.lastConfirmedAt || new Date().toISOString();
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

  async queryEventsByCase(caseId: string): Promise<AnyEvent[]> {
    const res = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `CASE#${caseId}`,
        ':skPrefix': 'EVENT#',
      },
    }));
    return (res.Items || []).map(i => i.data);
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
    } catch {
      // Fallback if GSI1 is not yet provisioned
      const res = await this.docClient.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'EntityType = :type',
        ExpressionAttributeValues: {
          ':type': 'EVENT_HISTORY',
        },
        Limit: limit,
      }));
      return (res.Items || []).map(i => i.data);
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
}
