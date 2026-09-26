import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

export type JivaMetricName =
  | 'JIVA_EVENTS_PROCESSED'
  | 'JIVA_EVENTS_FAILED'
  | 'HOSPITAL_ACCEPTANCE_LATENCY'
  | 'ROUTE_CALCULATION_LATENCY'
  | 'ACTIVE_EMERGENCIES'
  | 'ACTIVE_AMBULANCES'
  | 'AI_REQUESTS'
  | 'AI_FAILURES'
  | 'AI_LATENCY'
  | 'ANOMALIES_DETECTED';

export class MetricsCollector {
  private client?: CloudWatchClient;
  private namespace = 'JIVA/HealthcareMesh';
  private isAws: boolean;
  private localCounts = new Map<string, number>();

  constructor(isAws: boolean = false, region: string = 'ap-south-1') {
    this.isAws = isAws;
    if (this.isAws) {
      this.client = new CloudWatchClient({ region });
    }
  }

  async record(
    name: JivaMetricName,
    value: number = 1,
    unit: 'Count' | 'Milliseconds' = 'Count',
    dimensions?: Record<string, string>
  ): Promise<void> {
    const current = this.localCounts.get(name) || 0;
    this.localCounts.set(name, current + value);

    if (!this.isAws || !this.client) {
      // Local mode metric accounting
      return;
    }

    try {
      const formattedDimensions = dimensions
        ? Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value }))
        : undefined;

      await this.client.send(new PutMetricDataCommand({
        Namespace: this.namespace,
        MetricData: [
          {
            MetricName: name,
            Value: value,
            Unit: unit,
            Timestamp: new Date(),
            Dimensions: formattedDimensions,
          },
        ],
      }));
    } catch (err) {
      // Metric submission must never crash the operational flow
      console.warn(`[Metrics] CloudWatch publish failed for ${name}:`, err);
    }
  }

  getLocalMetricsSnapshot(): Record<string, number> {
    return Object.fromEntries(this.localCounts.entries());
  }
}
