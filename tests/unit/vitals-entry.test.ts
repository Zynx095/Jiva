/**
 * Manual vital-sign entry (no device connected): the screens' entry limits mirror the server's rules, an
 * empty field is "not recorded" (never a default), and typing errors are explained before sending.
 */
import { MEASUREMENT_RULES } from '../../packages/event-schema/src';
import { MEASUREMENT_LIMITS, MEASUREMENT_ORDER, enteredValueProblem, parseEntered } from '../../packages/ui/src/lib/vitals';
import { check, eq, ok, run } from './helpers/assert';

run('Manual vital-sign entry', async () => {
  await check('the screens use exactly the server\'s units and plausibility limits, for every measurement type', () => {
    eq([...MEASUREMENT_ORDER].sort(), Object.keys(MEASUREMENT_RULES).sort(), 'same measurement types');
    for (const t of MEASUREMENT_ORDER) {
      const server = MEASUREMENT_RULES[t] as { unit: string; min: number; max: number; secondaryMin?: number; secondaryMax?: number };
      eq(MEASUREMENT_LIMITS[t], { unit: server.unit, min: server.min, max: server.max, ...(server.secondaryMin !== undefined ? { secondaryMin: server.secondaryMin, secondaryMax: server.secondaryMax } : {}) }, t);
    }
  });

  await check('an empty field is not recorded — no value is substituted', () => {
    eq(parseEntered(''), undefined, 'empty');
    eq(parseEntered('   '), undefined, 'blank');
    for (const t of MEASUREMENT_ORDER) eq(enteredValueProblem(t, '', ''), null, `${t} empty is fine`);
  });

  await check('typed numbers: a decimal comma is accepted, anything else is explained', () => {
    eq(parseEntered('37,4'), 37.4, 'decimal comma');
    eq(enteredValueProblem('TEMPERATURE', '37,4'), null, 'plausible temperature');
    ok(enteredValueProblem('HEART_RATE', 'abc')?.includes('enter a number'), 'not a number');
    ok(enteredValueProblem('SPO2', '140')?.includes('between 50 and 100'), 'out of range names the limits');
    ok(enteredValueProblem('BLOOD_GLUCOSE', '1500')?.includes('typing error'), 'glucose out of range');
    eq(enteredValueProblem('BLOOD_GLUCOSE', '142'), null, 'plausible glucose');
  });

  await check('blood pressure needs both values, systolic above diastolic', () => {
    ok(enteredValueProblem('BLOOD_PRESSURE', '120', '')?.includes('both'), 'missing diastolic');
    ok(enteredValueProblem('BLOOD_PRESSURE', '', '80')?.includes('both'), 'missing systolic');
    ok(enteredValueProblem('BLOOD_PRESSURE', '80', '90')?.includes('higher'), 'systolic below diastolic');
    eq(enteredValueProblem('BLOOD_PRESSURE', '128', '84'), null, 'plausible');
  });
});
