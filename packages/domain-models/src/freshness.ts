export type FreshnessStatus = 'LIVE' | 'STALE' | 'UNKNOWN';

export function calculateFreshnessSeconds(timestamp: string): number {
  const eventTime = new Date(timestamp).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - eventTime) / 1000));
}

export function getFreshnessStatus(timestamp: string, staleThresholdSeconds = 600): FreshnessStatus {
  if (!timestamp) return 'UNKNOWN';
  const age = calculateFreshnessSeconds(timestamp);
  if (age > staleThresholdSeconds) return 'STALE';
  return 'LIVE';
}
