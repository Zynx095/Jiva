import { 
  AIProvider, 
  ClinicalHandoffInput, ClinicalHandoffOutput, 
  AnomalyExplanationInput, AnomalyExplanationOutput,
  EmergencySummaryInput, EmergencySummaryOutput 
} from './provider';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';

const ClinicalHandoffSchema = z.object({
  summary: z.string(),
  criticalAlerts: z.array(z.string()),
  recommendedPreparations: z.array(z.string())
});

const AnomalyExplanationSchema = z.object({
  explanation: z.string(),
  severityAssessment: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  suggestedActions: z.array(z.string())
});

const EmergencySummarySchema = z.object({
  briefSummary: z.string(),
  timelineHighlights: z.array(z.string())
});

export class BedrockAIProvider implements AIProvider {
  private client: BedrockRuntimeClient;
  private modelId = 'anthropic.claude-3-haiku-20240307-v1:0';

  constructor(region: string = 'us-east-1') {
    this.client = new BedrockRuntimeClient({ region });
  }

  private async invokeClaude<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
    const systemPrompt = `You are an AI assistant for JIVA, a real-time emergency coordination platform. 
    You must return ONLY valid JSON matching the requested structure. Do NOT include markdown blocks or any conversational text.`;
    
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: prompt }
      ]
    };

    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload)
    });

    try {
      const response = await this.client.send(command);
      const decodedBody = new TextDecoder().decode(response.body);
      const responseJson = JSON.parse(decodedBody);
      
      const content = responseJson.content?.[0]?.text;
      if (!content) throw new Error('No content from Bedrock');
      
      // Attempt to parse just the JSON part in case it wrapped it
      const match = content.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : content;
      
      const parsed = JSON.parse(jsonStr);
      return schema.parse(parsed);
    } catch (err) {
      console.error('[BedrockAIProvider] Error invoking model:', err);
      throw err;
    }
  }

  async generateClinicalHandoff(input: ClinicalHandoffInput): Promise<ClinicalHandoffOutput> {
    const prompt = `Generate a concise clinical handoff for the destination hospital.
    Patient ID: ${input.patient.patientId}
    Severity: ${input.patient.currentStatus}
    Care Requirements: ${input.patient.careRequirements.join(', ')}
    Ambulance: ${input.ambulance.ambulanceId}
    
    Return a JSON object with:
    - summary (string)
    - criticalAlerts (array of strings)
    - recommendedPreparations (array of strings)`;
    
    return this.invokeClaude(prompt, ClinicalHandoffSchema);
  }

  async explainAnomaly(input: AnomalyExplanationInput): Promise<AnomalyExplanationOutput> {
    const prompt = `Explain the following operational anomalies detected during an emergency response.
    Patient ID: ${input.patient.patientId}
    Anomalies: ${input.anomalies.join(', ')}
    
    Return a JSON object with:
    - explanation (string)
    - severityAssessment (LOW, MEDIUM, HIGH, or CRITICAL)
    - suggestedActions (array of strings)`;

    return this.invokeClaude(prompt, AnomalyExplanationSchema);
  }

  async summarizeEmergency(input: EmergencySummaryInput): Promise<EmergencySummaryOutput> {
    const prompt = `Provide a brief summary and timeline highlights for this emergency.
    Patient ID: ${input.patient.patientId}
    Requirements: ${input.patient.careRequirements.join(', ')}
    Event Count: ${input.events.length}
    
    Return a JSON object with:
    - briefSummary (string)
    - timelineHighlights (array of strings, max 5)`;

    return this.invokeClaude(prompt, EmergencySummarySchema);
  }
}
