/**
 * The local (mock) AI provider only restates facts from its input: it must never assert a diagnosis,
 * a severity or a timeline milestone that did not happen (regression: every handoff brief used to say
 * "High severity trauma · Prepare trauma bay", and every summary "Hospital accepted").
 */
import type { AmbulanceState, HospitalState, PatientState } from '../../packages/domain-models/src';
import { MockAIProvider } from '../../packages/intelligence/src/mockProvider';
import { check, eq, ok, run } from './helpers/assert';

const ai = new MockAIProvider();
const patient = (over: Partial<PatientState>): PatientState => ({
  patientId: 'CASE-T-1', currentStatus: 'IN_TRANSIT', careRequirements: ['EMERGENCY', 'ICU'], activeConditions: ['Reported: chest pain'],
  lastUpdated: new Date().toISOString(), provenance: [], ...over,
});
const hospital = { hospitalId: 'HOSP-T' } as unknown as HospitalState;
const ambulance = { ambulanceId: 'AMB-T' } as unknown as AmbulanceState;
const ev = (eventType: string, payload: Record<string, unknown> = {}) => ({ eventType, payload });

run('Mock AI restates facts only', async () => {
  await check('a chest-pain handoff never mentions trauma and restates the crew-reported symptoms as not a diagnosis', async () => {
    const out = await ai.generateClinicalHandoff({ patient: patient({ reportedSymptoms: ['Chest pain'] }), hospital, ambulance, events: [] });
    const text = [out.summary, ...out.criticalAlerts, ...out.recommendedPreparations].join(' ').toLowerCase();
    ok(!text.includes('trauma'), `unexpected trauma claim: ${text}`);
    ok(out.criticalAlerts.some(a => a.includes('Chest pain') && a.includes('not a diagnosis')), 'symptoms restated');
    eq(out.recommendedPreparations.length, 2, 'one preparation per assessed capability');
  });

  await check('a trauma case may mention TRAUMA because the care requirement says so', async () => {
    const out = await ai.generateClinicalHandoff({ patient: patient({ careRequirements: ['EMERGENCY', 'TRAUMA'] }), hospital, ambulance, events: [] });
    ok(out.recommendedPreparations.some(p => p.includes('TRAUMA')), 'trauma readiness from the requirement');
  });

  await check('summary highlights list only milestones present in the events', async () => {
    const none = await ai.summarizeEmergency({ patient: patient({}), events: [ev('patient.emergency.created'), ev('ambulance.dispatched')] });
    eq(none.timelineHighlights, ['Emergency reported', 'Ambulance dispatched'], 'no acceptance yet');
    const rejected = await ai.summarizeEmergency({ patient: patient({}), events: [ev('patient.emergency.created'), ev('hospital.acceptance.received', { status: 'REJECTED' })] });
    ok(!rejected.timelineHighlights.includes('Hospital accepted'), 'a rejection is not an acceptance');
    const accepted = await ai.summarizeEmergency({ patient: patient({}), events: [ev('hospital.acceptance.received', { status: 'ACCEPTED' })] });
    eq(accepted.timelineHighlights, ['Hospital accepted'], 'acceptance');
  });
});
