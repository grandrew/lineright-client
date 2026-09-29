/**
 * Distance on a sphere. No dependencies, no network, no surprises.
 *
 * The DMV publishes latitude and longitude for every field office, so "any
 * office within 25 miles" is a real geodesic question rather than a guess from
 * ZIP prefixes. Earth is not a sphere, but at California scale the haversine
 * error is well under a tenth of a percent — nothing next to the fact that a
 * bidder picked "25 miles" as a round number in the first place.
 */
export const EARTH_RADIUS_MILES = 3958.7613;
export const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg) => (deg * Math.PI) / 180;

export function isCoordinate(point) {
  return Boolean(point)
    && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

/** Great-circle distance in miles between two {lat, lng} points. */
export function milesBetween(a, b) {
  if (!isCoordinate(a) || !isCoordinate(b)) {
    throw new Error('milesBetween needs two {lat, lng} coordinates');
  }
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function kmToMiles(km) { return (km * EARTH_RADIUS_MILES) / EARTH_RADIUS_KM; }
export function milesToKm(miles) { return (miles * EARTH_RADIUS_KM) / EARTH_RADIUS_MILES; }

/** Rounded the way distances are quoted to people, not to satellites. */
export function roundMiles(miles) { return Math.round(miles * 10) / 10; }
