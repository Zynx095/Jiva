/**
 * Links between the apps (portal role cards, back-to-portal, "open in the doctor workspace"): a link stays in
 * the port family the page is served from — development, production preview or the browser tests — and only
 * carries the demo persona it was given.
 */
import { jivaAppUrl } from '../../packages/ui/src/lib/apps';
import { check, eq, run } from './helpers/assert';

const at = (port: string, protocol = 'http:', hostname = 'localhost') => ({ port, protocol, hostname }) as unknown as Location;

run('Links between the apps', async () => {
  await check('development (5173–5178): the portal links to each app in the same family', () => {
    eq(jivaAppUrl('doctor', 'demo-doc-3', at('5178')), 'http://localhost:5177/?as=demo-doc-3', 'doctor');
    eq(jivaAppUrl('demo', undefined, at('5174')), 'http://localhost:5178/', 'back to the portal, no persona');
  });

  await check('production preview (4173–4178) and the browser tests (5183–5188) keep their own family', () => {
    eq(jivaAppUrl('hospital', 'demo-hosp-1', at('4178')), 'http://localhost:4175/?as=demo-hosp-1', 'preview');
    eq(jivaAppUrl('patient', 'demo-patient-1', at('5188')), 'http://localhost:5186/?as=demo-patient-1', 'browser tests');
  });

  await check('a page outside any family falls back to development ports; the host is kept', () => {
    eq(jivaAppUrl('management', undefined, at('', 'https:', 'jiva.example')), 'https://jiva.example:5173/', 'default https port');
    eq(jivaAppUrl('ambulance', 'demo-amb-2', at('3000')), 'http://localhost:5174/?as=demo-amb-2', 'unrelated port');
  });
});
