import fs from 'fs';
import path from 'path';

// Adapters
interface DataSourceAdapter {
  id: string;
  name: string;
  url: string;
  fetchData(): Promise<any[]>;
  canAutoFetch: boolean;
  limitations?: string;
}

const adapters: DataSourceAdapter[] = [
  {
    id: 'bengaluru-urban',
    name: 'Bengaluru Urban Government Hospital Directory',
    url: 'https://bengaluruurban.nic.in/en/public-utility-category/hospitals/',
    canAutoFetch: false,
    limitations: 'HTML page protected by captchas/WAF or requires manual HTML scraping. No structured API provided.',
    async fetchData() {
      // Since we can't auto-fetch, we'll read a manually populated raw JSON file if it exists
      const manualPath = path.join(__dirname, '../data/sources/bengaluru-urban/manual-extract.json');
      if (fs.existsSync(manualPath)) {
        return JSON.parse(fs.readFileSync(manualPath, 'utf8'));
      }
      console.warn('[bengaluru-urban] Cannot autofetch and no manual extract found.');
      return [];
    }
  },
  {
    id: 'bbmp',
    name: 'BBMP Health Department Hospital Directory',
    url: 'https://site.bbmp.gov.in/departmentwebsites/Health/palikehospitals.html',
    canAutoFetch: false,
    limitations: 'Static HTML table, requires manual extraction or headless browser to parse effectively.',
    async fetchData() {
      const manualPath = path.join(__dirname, '../data/sources/bbmp/manual-extract.json');
      if (fs.existsSync(manualPath)) {
        return JSON.parse(fs.readFileSync(manualPath, 'utf8'));
      }
      console.warn('[bbmp] Cannot autofetch and no manual extract found.');
      return [];
    }
  },
  {
    id: 'institutions',
    name: 'Official Hospital Institutions / Websites',
    url: 'Multiple',
    canAutoFetch: false,
    limitations: 'Highly unstructured and disparate. Handled via manual verification entry.',
    async fetchData() {
      const manualPath = path.join(__dirname, '../data/sources/institutions/manual-extract.json');
      if (fs.existsSync(manualPath)) {
        return JSON.parse(fs.readFileSync(manualPath, 'utf8'));
      }
      console.warn('[institutions] No manual extract found.');
      return [];
    }
  }
];

async function main() {
  console.log('--- JIVA DATA PIPELINE: FETCH ---');
  
  for (const adapter of adapters) {
    console.log(`Fetching from: ${adapter.name}...`);
    try {
      const data = await adapter.fetchData();
      if (data.length > 0) {
        fs.writeFileSync(
          path.join(__dirname, `../data/raw/${adapter.id}.json`), 
          JSON.stringify(data, null, 2)
        );
        console.log(`✓ Fetched ${data.length} raw records for ${adapter.id}`);
      }
    } catch (e) {
      console.error(`✗ Error fetching ${adapter.id}:`, e);
    }
  }
}

main();
