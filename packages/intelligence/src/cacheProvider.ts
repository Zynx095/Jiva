import { 
  AIProvider, 
  ClinicalHandoffInput, ClinicalHandoffOutput, 
  AnomalyExplanationInput, AnomalyExplanationOutput,
  EmergencySummaryInput, EmergencySummaryOutput 
} from './provider';

export class CachedAIProvider implements AIProvider {
  private cache = new Map<string, any>();

  constructor(private delegate: AIProvider) {}

  private getHash(input: any): string {
    // Simple hashing by stringifying input
    return JSON.stringify(input);
  }

  async generateClinicalHandoff(input: ClinicalHandoffInput): Promise<ClinicalHandoffOutput> {
    const key = `handoff_${this.getHash(input)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    
    const result = await this.delegate.generateClinicalHandoff(input);
    this.cache.set(key, result);
    return result;
  }

  async explainAnomaly(input: AnomalyExplanationInput): Promise<AnomalyExplanationOutput> {
    const key = `anomaly_${this.getHash(input)}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const result = await this.delegate.explainAnomaly(input);
    this.cache.set(key, result);
    return result;
  }

  async summarizeEmergency(input: EmergencySummaryInput): Promise<EmergencySummaryOutput> {
    const key = `summary_${this.getHash(input)}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const result = await this.delegate.summarizeEmergency(input);
    this.cache.set(key, result);
    return result;
  }
}
