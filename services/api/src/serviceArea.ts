/**
 * Geographic service area of this JIVA deployment. Emergencies reported outside it are rejected at
 * intake (a mis-tapped map pin must not silently create a case JIVA cannot serve).
 *
 * Default: a bounding box around Bengaluru Urban district. Override with
 * JIVA_SERVICE_AREA="minLat,minLng,maxLat,maxLng[,name]".
 */
export interface ServiceArea {
  name: string;
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const DEFAULT_AREA: ServiceArea = { name: 'Bengaluru Urban', minLat: 12.7, minLng: 77.3, maxLat: 13.3, maxLng: 77.95 };

export function serviceArea(): ServiceArea {
  const raw = process.env.JIVA_SERVICE_AREA;
  if (!raw) return DEFAULT_AREA;
  const [minLat, minLng, maxLat, maxLng, name] = raw.split(',').map(s => s.trim());
  const nums = [minLat, minLng, maxLat, maxLng].map(Number);
  if (nums.some(n => !Number.isFinite(n)) || nums[0] >= nums[2] || nums[1] >= nums[3]) {
    console.warn('[ServiceArea] Ignoring malformed JIVA_SERVICE_AREA; using the default.');
    return DEFAULT_AREA;
  }
  return { name: name || 'Configured area', minLat: nums[0], minLng: nums[1], maxLat: nums[2], maxLng: nums[3] };
}

export function isWithinServiceArea(latitude: number, longitude: number, area: ServiceArea = serviceArea()): boolean {
  return latitude >= area.minLat && latitude <= area.maxLat && longitude >= area.minLng && longitude <= area.maxLng;
}
