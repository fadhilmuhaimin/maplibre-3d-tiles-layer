// Named imports work with MapLibre 5 and 6 (v6 dropped the default export).
import { Map as MaplibreMap, NavigationControl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ThreeDTilesLayer, ecefToLngLat, type LngLat, type QualityPreset } from 'maplibre-3d-tiles-layer';

/*
 * URL parameters:
 *   ?tileset=<url>         tileset.json to load (default: Cesium sample dragon)
 *   ?quality=balanced|max
 *   ?alt=<metres>          initial altitude offset
 *   ?lng=&lat=             anchor; computed from the tileset bounds when omitted
 *   ?basemap=osm           OSM raster instead of OpenFreeMap Positron
 *
 * For a local tileset, put it in examples/basic/public/tiles/ (gitignored)
 * and open ?tileset=/tiles/tileset.json
 */
const DEFAULT_TILESET =
    'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithDiscreteLOD/tileset.json';
const LAYER_ID = '3d-tiles';

const params = new URLSearchParams(location.search);
const tilesetUrl = new URL(params.get('tileset') ?? DEFAULT_TILESET, location.href).href;
const quality = (params.get('quality') ?? 'balanced') as QualityPreset;
let altitudeOffset = Number(params.get('alt') ?? 0);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statsEl = $('stats');
const errorEl = $('error');
const barEl = $('bar').firstElementChild as HTMLDivElement;

$('source').textContent = tilesetUrl.split('/').slice(-2).join('/');
$<HTMLSelectElement>('quality').value = quality;
$<HTMLSelectElement>('quality').onchange = (e) => {
    params.set('quality', (e.target as HTMLSelectElement).value);
    location.search = params.toString();
};

/**
 * Read the tileset's root bounding volume and return its centre as lng/lat.
 * Handles `box` and `sphere` volumes (with the root `transform`) and `region`.
 */
async function findTilesetCentre(url: string): Promise<LngLat> {
    const tileset = await (await fetch(url)).json();
    const { root } = tileset;
    const bv = root.boundingVolume;
    if (bv.region) {
        const [west, south, east, north] = bv.region as number[];
        return { lng: ((west + east) / 2) * (180 / Math.PI), lat: ((south + north) / 2) * (180 / Math.PI) };
    }
    const [x, y, z] = (bv.box ?? bv.sphere) as number[];
    const m: number[] = root.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const { lng, lat } = ecefToLngLat(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14]
    );
    return { lng, lat };
}

const origin: LngLat =
    params.has('lng') && params.has('lat')
        ? { lng: Number(params.get('lng')), lat: Number(params.get('lat')) }
        : await findTilesetCentre(tilesetUrl);

// OpenFreeMap needs no API key. Positron is flat (no extruded buildings to
// clash with the tileset). ?basemap=osm switches to OSM raster tiles.
const style: StyleSpecification | string =
    params.get('basemap') === 'osm'
        ? {
              version: 8,
              sources: {
                  osm: {
                      type: 'raster',
                      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                      tileSize: 256,
                      maxzoom: 19,
                      attribution: '© OpenStreetMap contributors',
                  },
              },
              layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
          }
        : 'https://tiles.openfreemap.org/styles/positron';

const map = new MaplibreMap({
    container: 'map',
    style,
    center: [origin.lng, origin.lat],
    zoom: 16,
    pitch: 55,
    maxPitch: 80,
});
map.addControl(new NavigationControl(), 'top-right');
// Handy for poking at the layer from the devtools console.
Object.assign(window, { map });

function createLayer() {
    return new ThreeDTilesLayer({
        id: LAYER_ID,
        url: tilesetUrl,
        origin,
        altitudeOffset,
        quality,
        debug: true,
        onProgress: (progress, s) => {
            barEl.style.width = `${Math.round(progress * 100)}%`;
            statsEl.textContent =
                `progress  ${(progress * 100).toFixed(0)}%\n` +
                `loaded    ${s.loaded}   failed ${s.failed}\n` +
                `queued    ${s.queued}   downloading ${s.downloading}   parsing ${s.parsing}\n` +
                `visible   ${s.visible}   cache ${(s.cachedBytes / 1024 ** 2).toFixed(1)} MB`;
        },
        onError: (err, url) => {
            errorEl.textContent = `Failed: ${url.split('/').pop()} (${err.message})`;
        },
    });
}

let layer = createLayer();

map.on('load', () => {
    map.addLayer(layer);
    Object.assign(window, { layer });
});

$<HTMLInputElement>('alt').value = String(altitudeOffset);
$('alt-value').textContent = `${altitudeOffset} m`;
$<HTMLInputElement>('alt').oninput = (e) => {
    altitudeOffset = Number((e.target as HTMLInputElement).value);
    $('alt-value').textContent = `${altitudeOffset} m`;
    layer.setAltitudeOffset(altitudeOffset);
};

$('toggle').onclick = () => {
    if (!map.getLayer(LAYER_ID)) return;
    const visible = map.getLayoutProperty(LAYER_ID, 'visibility') !== 'none';
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'none' : 'visible');
    $('toggle').textContent = visible ? 'Show' : 'Hide';
};

$('readd').onclick = () => {
    if (map.getLayer(LAYER_ID)) {
        map.removeLayer(LAYER_ID);
        $('readd').textContent = 'Add';
    } else {
        layer = createLayer();
        map.addLayer(layer);
        Object.assign(window, { layer });
        $('readd').textContent = 'Remove';
    }
};

$('fly').onclick = () => map.flyTo({ center: [origin.lng, origin.lat], zoom: 17, pitch: 60 });
