/** Approximate [longitude, latitude] for each country Argus sees traffic from. */
export const CENTROID: Record<string, [number, number]> = {
  US: [-98.5, 39.5],
  CA: [-79.4, 43.7],
  MX: [-103.3, 20.7],
  BR: [-49.3, -25.4],
  GB: [-1.5, 53.8],
  IE: [-6.3, 53.3],
  FR: [4.8, 45.8],
  DE: [10, 53.5],
  NL: [5.1, 52.1],
  ES: [-0.4, 39.5],
  IT: [9.2, 45.5],
  RO: [26.1, 44.4],
  UA: [30.5, 50.4],
  RU: [37.6, 55.8],
  AE: [55.3, 25.2],
  NG: [3.4, 6.5],
  GH: [-0.2, 5.6],
  IN: [77.6, 12.97],
  CN: [121.5, 31.2],
  VN: [106.7, 10.8],
  ID: [106.8, -6.2],
  SG: [103.8, 1.35],
  JP: [135.5, 34.7],
  KR: [129.1, 35.2],
  AU: [144.96, -37.8],
};

/** Small, stable offset so several cities in one country don't stack on one pixel. */
export function jitter(cc: string, key: string): [number, number] | null {
  const c = CENTROID[cc];
  if (!c) return null;
  let h = 7;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [c[0] + ((h % 100) / 100 - 0.5) * 4, c[1] + (((h >> 8) % 100) / 100 - 0.5) * 3];
}
