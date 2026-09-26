/**
 * Decodes an encoded polyline string into an array of GeoJSON [longitude, latitude] pairs.
 * @param str Encoded polyline string
 * @param precision Default 5 (standard OSRM/Google), or 6 for Valhalla shape format
 */
export function decodePolyline(str: string, precision = 5): [number, number][] {
  if (!str) return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: [number, number][] = [];
  const factor = Math.pow(10, precision);

  while (index < str.length) {
    let byte = 0;
    let shift = 0;
    let result = 0;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += deltaLng;

    coordinates.push([Number((lng / factor).toFixed(6)), Number((lat / factor).toFixed(6))]);
  }

  return coordinates;
}

/**
 * Encodes an array of GeoJSON [longitude, latitude] pairs into an encoded polyline string.
 * @param coordinates Array of [lng, lat]
 * @param precision Default 5
 */
export function encodePolyline(coordinates: [number, number][], precision = 5): string {
  if (!coordinates || coordinates.length === 0) return '';
  const factor = Math.pow(10, precision);
  let output = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lng, lat] of coordinates) {
    const late5 = Math.round(lat * factor);
    const lnge5 = Math.round(lng * factor);

    let dLat = late5 - prevLat;
    let dLng = lnge5 - prevLng;

    prevLat = late5;
    prevLng = lnge5;

    for (let val of [dLat, dLng]) {
      val = val < 0 ? ~(val << 1) : (val << 1);
      while (val >= 0x20) {
        output += String.fromCharCode((0x20 | (val & 0x1f)) + 63);
        val >>= 5;
      }
      output += String.fromCharCode(val + 63);
    }
  }

  return output;
}

