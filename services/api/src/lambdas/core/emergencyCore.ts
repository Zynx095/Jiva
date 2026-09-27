import { observeValue } from '../../feasibility/containment';
import { caseAcceptanceStatus } from '../../feasibility/acceptanceLedger';
import { loadAcceptanceView } from './deps';
import type { CapabilityType, CareRequirement } from '@jiva/domain-models';
import { evaluateHospitals } from '../../eligibilityEngine';
import {
  assessRequiredCapabilities,
  buildAcceptanceRequest,
  requirementProvenanceOf,
  selectRequestTargets,
} from '../../stateTransitions';
import { LambdaDeps, newId, nowIso, nowMs, publishSystem, recordThenPublish } from './deps';

const DEFAULT_ORIGIN = { latitude: 12.9716, longitude: 77.5946 };

/**
 * AWS emergency processor. Mirrors the local state engine:
 *  patient.emergency.created  -> deterministic assessment -> patient state -> care.requirement.created
 *  care.requirement.created   -> legacy candidate evaluation -> candidate event -> acceptance requests
 * Decisions come from the shared modules; the Care Feasibility Engine runs in shadow only.
 */
export function createEmergencyHandler(d: LambdaDeps) {
  return async (event: { 'detail-type'?: string; detail: any }) => {
    const jivaEvent = event.detail;
    console.log(`[Lambda:EmergencyProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

    const recordResult = await d.store.recordEvent(jivaEvent);
    if (recordResult.isDuplicate) {
      console.log(`[Lambda:EmergencyProcessor] Skipping duplicate event ${jivaEvent.eventId}`);
      return { status: 'duplicate_skipped' };
    }

    if (jivaEvent.eventType === 'patient.emergency.created') {
      const patientId: string = jivaEvent.patientId || `CASE-${newId(d).substring(0, 8).toUpperCase()}`;
      const existing = await d.store.getPatient(patientId);
      if (existing && existing.currentStatus !== 'DISCHARGED') {
        console.warn(`[StateEngine] Emergency for active case ${patientId} ignored (already open).`);
        return { status: 'ignored_active_case' };
      }
      const { condition, severity, location } = jivaEvent.payload;
      const required = assessRequiredCapabilities(condition, severity);
      await d.store.setPatient({
        patientId,
        currentStatus: 'ASSESSED',
        currentLocation: { latitude: location.latitude, longitude: location.longitude },
        careRequirements: required,
        activeConditions: [condition],
        lastUpdated: jivaEvent.timestamp,
        provenance: [{
          sourceType: jivaEvent.source.type,
          sourceId: jivaEvent.source.id,
          eventId: jivaEvent.eventId,
          timestamp: jivaEvent.timestamp,
          confidence: jivaEvent.metadata?.confidence ?? 1.0,
        }],
      });

      await publishSystem(d, {
        eventType: 'care.requirement.created',
        source: { type: 'system', id: 'assessment-engine' },
        patientId,
        causationId: jivaEvent.eventId,
        payload: {
          requirementId: `REQ-${newId(d).substring(0, 8)}`,
          caseId: patientId,
          requiredCapabilities: required,
          optionalCapabilities: [],
          severity,
          createdAt: nowIso(d),
        },
      });
    } else if (jivaEvent.eventType === 'care.requirement.created') {
      const req = jivaEvent.payload;
      const patient = await d.store.getPatient(req.caseId);
      const origin = patient?.currentLocation || DEFAULT_ORIGIN;

      const requirement: CareRequirement = {
        requirementId: req.requirementId,
        caseId: req.caseId,
        requiredCapabilities: req.requiredCapabilities as CapabilityType[],
        optionalCapabilities: req.optionalCapabilities as CapabilityType[],
        severity: req.severity,
        createdAt: req.createdAt,
        expiresAt: req.expiresAt,
        source: jivaEvent.source.id,
      };
      // Observational only: only the shadow's requirementSource reads this.
      await observeValue('materialize.requirement', () => d.store.putLatestRequirement?.(req.caseId, requirement), undefined);

      const hospitals = await d.store.listHospitals();
      const nowForAcceptance = nowMs(d);
      const acceptanceView = await loadAcceptanceView(d.store, req.caseId, hospitals.map(h => h.hospitalId), nowForAcceptance);
      const candidates = await evaluateHospitals(requirement, origin, {
        hospitals, mapping: d.mapping, nowMs: nowForAcceptance,
        acceptanceOverride: hospitalId => caseAcceptanceStatus(acceptanceView.view(req.caseId, hospitalId, nowForAcceptance), nowForAcceptance),
      });

      await publishSystem(d, {
        eventType: 'hospital.candidate.generated',
        source: { type: 'system', id: 'eligibility-engine' },
        causationId: jivaEvent.eventId,
        payload: {
          caseId: req.caseId,
          candidates: candidates.map(c => ({
            hospitalId: c.hospitalId,
            hospitalName: c.hospitalName,
            capabilityMatch: c.capabilityMatch,
            missingCapabilities: c.missingCapabilities,
            operationalEligibility: c.operationalEligibility,
            distanceKm: c.distanceKm,
            etaMinutes: c.etaMinutes,
            reason: c.reason,
          })),
        },
      });

      // Existing request-selection boundary (shared with local): INDETERMINATE projects to
      // INELIGIBLE, so it is never requestable.
      for (const c of selectRequestTargets(candidates)) {
        const payload = buildAcceptanceRequest(requirement, c, `AR-${newId(d).substring(0, 8)}`, nowMs(d));
        // Observational only: requests are not consulted by evaluateHospitals' acceptanceOverride
        // (only recorded responses are); kept as an auxiliary write for the shadow's correlation rule.
        await observeValue('materialize.request', () => d.store.putAcceptanceRequest?.(payload.caseId, payload.hospitalId, payload), undefined);
        await recordThenPublish(d, {
          eventType: 'hospital.acceptance.requested',
          source: { type: 'system', id: 'acceptance-protocol' },
          causationId: jivaEvent.eventId,
          payload,
        });
      }

      if (d.shadow) {
        // Shadow only: evaluated after requests are recorded; compared with the legacy candidates.
        const shadow = d.shadow;
        await observeValue('shadow.candidate-generation', () => shadow.evaluate({
          context: 'candidate-generation',
          requirement,
          requirementProvenance: requirementProvenanceOf(jivaEvent.source?.type),
          trigger: { eventId: jivaEvent.eventId, eventType: jivaEvent.eventType, sourceId: jivaEvent.source?.id || 'unknown', sourceType: jivaEvent.source?.type },
          origin,
          originAsOf: patient?.lastUpdated,
          hospitals,
          legacyCandidates: candidates,
        }), undefined);
      }
    }

    return { status: 'processed' };
  };
}
