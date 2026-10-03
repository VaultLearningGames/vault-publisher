// The analytics world map's projection: plain equirectangular, cut at 85°N and 58°S (no Antarctica), so a longitude
// and latitude become x and y on public/world-map.svg. Small countries' points are where Natural Earth puts their labels.
export const MAP_WIDTH = 1000;
const NORTH = 85, SOUTH = -58;
export const MAP_HEIGHT = Math.round((MAP_WIDTH * (NORTH - SOUTH)) / 360);

export function project(lon: number, lat: number): [number, number] {
  return [((lon + 180) / 360) * MAP_WIDTH, ((NORTH - Math.max(SOUTH, Math.min(NORTH, lat))) / (NORTH - SOUTH)) * MAP_HEIGHT];
}
