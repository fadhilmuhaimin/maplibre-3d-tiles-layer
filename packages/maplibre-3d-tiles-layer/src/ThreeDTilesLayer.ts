import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
    TilesRenderer,
    LRUCache,
    PriorityQueue,
    DownloadPriorityQueue,
    DEFAULT_LRU_CACHE,
    DEFAULT_DOWNLOAD_QUEUE,
    DEFAULT_PARSE_QUEUE,
} from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import type { CustomLayerInterface } from 'maplibre-gl';

import {
    TILE_SIZE,
    ecefToMercatorMatrix,
    enuBasis,
    lngLatToEcef,
    lngLatToMercator,
    mercatorUnitsPerMetre,
    splitCameraRelative,
    type LngLat,
} from './math';
import {
    resolveQuality,
    type QualityOverrides,
    type QualityPreset,
    type QualitySettings,
} from './presets';
import { TilePreparePlugin, type TileMaterialMode } from './TilePreparePlugin';

const LOG_PREFIX = '[maplibre-3d-tiles-layer]';
const DEFAULT_DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

export interface ThreeDTilesLayerOptions {
    /** MapLibre layer id. */
    id: string;
    /** URL of the root `tileset.json`. Relative URLs resolve against the page. */
    url: string;
    /**
     * Anchor point near the tileset centre. The ECEF→Mercator mapping is a
     * tangent-plane approximation around it, and the selection camera hovers
     * above it, so it should sit inside the tileset.
     */
    origin: LngLat;
    /** Metres added to the tileset's height. Raise it if the model renders underground. Default `0`. */
    altitudeOffset?: number;
    /**
     * Loading quality. `'balanced'` (default) is safe on phones; `'max'` loads
     * every leaf tile for a single photogrammetry site on desktop. An object
     * is merged over `'balanced'`.
     */
    quality?: QualityPreset | QualityOverrides;
    /**
     * Fixed camera used to choose which tiles to load, independent of the
     * map view. See README "How tile selection works". Default `{ height: 500, fov: 90 }`.
     */
    selectionCamera?: { height?: number; fov?: number };
    /** Cross-fade between LODs. `false` disables it. Default `{ duration: 500, maxFadeOutTiles: 100 }`. */
    fade?: false | { duration?: number; maxFadeOutTiles?: number };
    /**
     * `'auto'` (default) renders textured meshes unlit (photogrammetry has
     * lighting baked into its photos) and lights untextured ones.
     * `'unlit'` / `'original'` force one behaviour for every mesh.
     */
    material?: TileMaterialMode;
    /**
     * Draco decoding. `false` disables it. By default three r185+ uses the
     * decoder bundled with three; older versions load it from Google's CDN (v1.5.6).
     */
    draco?: false | { decoderPath?: string };
    /** KTX2 texture loader with its transcoder path set. The layer calls `detectSupport` for you. */
    ktx2Loader?: KTX2Loader;
    /** `MeshoptDecoder` from `three/addons/libs/meshopt_decoder.module.js`, for meshopt-compressed tiles. */
    meshoptDecoder?: typeof MeshoptDecoder;
    /** Options passed to every tile `fetch`, e.g. `{ headers: { Authorization: '…' } }`. */
    fetchOptions?: RequestInit;
    /** Clear the depth buffer before drawing so map layers below cannot occlude the tiles. Default `true`. */
    clearDepth?: boolean;
    /** How often (ms) to repaint the map while tiles are still streaming. Default `50`. */
    repaintInterval?: number;
    /** Called once the root tileset JSON has loaded. */
    onLoadTileset?: () => void;
    /** Called when loading progress changes. `progress` is 0–1. */
    onProgress?: (progress: number, stats: TilesStats) => void;
    /** Called when a tileset or tile fails to load. Logged with `console.warn` when omitted. */
    onError?: (error: Error, url: string) => void;
    /** Log loading stats every 2 s. Default `false`. */
    debug?: boolean;
}

export interface TilesStats {
    /** 0–1 */
    progress: number;
    queued: number;
    downloading: number;
    parsing: number;
    loaded: number;
    failed: number;
    visible: number;
    active: number;
    /** Tiles the last update wanted but could not queue because the cache was full. */
    refused: number;
    cachedTiles: number;
    cachedBytes: number;
}

/**
 * The parts of a MapLibre `Map` the layer uses. Typed structurally rather
 * than with `maplibre-gl`'s `Map`, so it fits MapLibre 5 and 6 typings even
 * when a project ends up with more than one copy installed.
 */
export interface MapLike {
    getCanvas(): HTMLCanvasElement;
    getZoom(): number;
    getCenter(): { lng: number; lat: number };
    triggerRepaint(): void;
}

/** The part of MapLibre's `CustomRenderMethodInput` the layer uses. */
export interface RenderInputLike {
    /** Mercator world (X/Y in worldSize units, Z in metres) → clip space. */
    modelViewProjectionMatrix: ArrayLike<number>;
}

/** Fields read from 3d-tiles-renderer's untyped `stats` object. */
interface RendererStats {
    queued: number;
    downloading: number;
    parsing: number;
    loaded: number;
    failed: number;
    visible: number;
    active: number;
    refused?: number;
}

/**
 * MapLibre custom layer that streams 3D Tiles with three.js and
 * 3d-tiles-renderer, sharing MapLibre's WebGL context.
 *
 * ```ts
 * map.on('load', () => {
 *   map.addLayer(new ThreeDTilesLayer({
 *     id: 'site',
 *     url: '/tiles/tileset.json',
 *     origin: { lng: 119.4048, lat: -5.1457 },
 *   }));
 * });
 * ```
 */
export class ThreeDTilesLayer implements CustomLayerInterface {
    readonly id: string;
    readonly type = 'custom' as const;
    readonly renderingMode = '3d' as const;

    private readonly options: ThreeDTilesLayerOptions;
    private readonly quality: QualitySettings;
    private altitudeOffset: number;

    private map: MapLike | null = null;
    private renderer: THREE.WebGLRenderer | null = null;
    private scene: THREE.Scene | null = null;
    private selectionCamera: THREE.PerspectiveCamera | null = null;
    private renderCamera: THREE.Camera | null = null;
    private tiles: TilesRenderer | null = null;
    private dracoLoader: DRACOLoader | null = null;
    private lruCache: LRUCache | null = null;
    private downloadQueue: DownloadPriorityQueue | null = null;
    private parseQueue: PriorityQueue | null = null;

    private maxAnisotropy = 1;
    private lastProgress = -1;
    private lastRenderAt = 0;
    private lastDebugLogAt = 0;
    private repaintTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: ThreeDTilesLayerOptions) {
        if (!options?.id) throw new Error(`${LOG_PREFIX} "id" is required`);
        if (!options.url) throw new Error(`${LOG_PREFIX} "url" is required`);
        const { origin } = options;
        if (!origin || !Number.isFinite(origin.lng) || !Number.isFinite(origin.lat)) {
            throw new Error(`${LOG_PREFIX} "origin" must be { lng, lat } numbers`);
        }

        this.id = options.id;
        this.options = options;
        this.quality = resolveQuality(options.quality);
        this.altitudeOffset = options.altitudeOffset ?? 0;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** The underlying 3d-tiles-renderer instance, for advanced use. `null` until added to a map. */
    get tilesRenderer(): TilesRenderer | null {
        return this.tiles;
    }

    /** Snapshot of loading and cache stats. `null` until added to a map. */
    getStats(): TilesStats | null {
        const { tiles, lruCache } = this;
        if (!tiles || !lruCache) return null;
        const s = (tiles as unknown as { stats: RendererStats }).stats;
        const cache = lruCache as unknown as { itemSet: Set<unknown>; cachedBytes: number };
        return {
            progress: tiles.loadProgress,
            queued: s.queued,
            downloading: s.downloading,
            parsing: s.parsing,
            loaded: s.loaded,
            failed: s.failed,
            visible: s.visible,
            active: s.active,
            refused: s.refused ?? 0,
            cachedTiles: cache.itemSet?.size ?? 0,
            cachedBytes: cache.cachedBytes ?? 0,
        };
    }

    /** Move the tileset up or down (metres) without reloading it. */
    setAltitudeOffset(metres: number): void {
        this.altitudeOffset = metres;
        this.map?.triggerRepaint();
    }

    // ── MapLibre lifecycle ───────────────────────────────────────────────────

    onAdd(map: MapLike, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
        const { options, quality } = this;
        this.map = map;

        const renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
        renderer.autoClear = false;
        this.renderer = renderer;
        this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

        // Selection camera: fixed above the origin, never moves. It is the only
        // camera registered with TilesRenderer, so what gets loaded does not
        // depend on the map's zoom. See README "How tile selection works".
        const { height = 500, fov = 90 } = options.selectionCamera ?? {};
        const selectionCamera = new THREE.PerspectiveCamera(fov, 1, 1, 1e9);
        selectionCamera.position.set(...lngLatToEcef(options.origin.lng, options.origin.lat, height));
        selectionCamera.lookAt(...lngLatToEcef(options.origin.lng, options.origin.lat, 0));
        selectionCamera.updateProjectionMatrix();
        selectionCamera.updateMatrixWorld(true);
        this.selectionCamera = selectionCamera;

        // Render camera: matrices are written by hand every frame in render().
        const renderCamera = new THREE.Camera();
        renderCamera.matrixAutoUpdate = false;
        renderCamera.matrixWorldAutoUpdate = false;
        this.renderCamera = renderCamera;

        const scene = new THREE.Scene();
        if (options.material !== 'unlit') addLocalLights(scene, options.origin);
        this.scene = scene;

        const tiles = new TilesRenderer(options.url);
        this.tiles = tiles;
        tiles.errorTarget = quality.errorTarget;
        tiles.maxDepth = quality.maxDepth;
        // Keep a parent visible until all of its children are ready, so
        // REPLACE-refined photogrammetry never shows holes while loading.
        tiles.displayActiveTiles = true;
        tiles.loadSiblings = true;
        // Three.js frustum planes extracted from an ECEF→clip matrix are too
        // imprecise and cull valid meshes. Tile-level culling still happens
        // in 3d-tiles-renderer using proper bounding volumes.
        tiles.autoDisableRendererCulling = true;
        if (options.fetchOptions) tiles.fetchOptions = options.fetchOptions;

        // 3d-tiles-renderer shares one cache and one set of queues between all
        // instances on the page. Give this layer its own so its budgets don't
        // change other tile renderers.
        this.lruCache = new LRUCache();
        this.lruCache.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback;
        this.lruCache.minBytesSize = quality.cache.minBytes;
        this.lruCache.maxBytesSize = quality.cache.maxBytes;
        this.lruCache.minSize = quality.cache.minTiles;
        this.lruCache.maxSize = quality.cache.maxTiles;
        tiles.lruCache = this.lruCache;

        this.downloadQueue = new DownloadPriorityQueue();
        this.downloadQueue.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback;
        this.downloadQueue.maxJobsPerOrigin = quality.downloadJobs;
        tiles.downloadQueue = this.downloadQueue;

        this.parseQueue = new PriorityQueue();
        this.parseQueue.priorityCallback = DEFAULT_PARSE_QUEUE.priorityCallback;
        this.parseQueue.maxJobs = quality.parseJobs;
        tiles.parseQueue = this.parseQueue;

        // ── Plugins ──────────────────────────────────────────────────────────
        tiles.registerPlugin(
            new TilePreparePlugin({
                material: options.material ?? 'auto',
                getMaxAnisotropy: () => this.maxAnisotropy,
            })
        );

        if (options.draco !== false) {
            this.dracoLoader = new DRACOLoader();
            // three r185+ ships a Draco decoder next to DRACOLoader and uses it
            // by default (no CDN, works on intranets). Older releases need a path.
            const decoderPath =
                options.draco?.decoderPath ??
                (Number.parseInt(THREE.REVISION, 10) >= 185 ? null : DEFAULT_DRACO_DECODER_PATH);
            if (decoderPath) this.dracoLoader.setDecoderPath(decoderPath);
            this.dracoLoader.preload();
        }
        options.ktx2Loader?.detectSupport(renderer);
        tiles.registerPlugin(
            new GLTFExtensionsPlugin({
                dracoLoader: this.dracoLoader,
                ktxLoader: options.ktx2Loader ?? null,
                meshoptDecoder: options.meshoptDecoder ?? null,
            })
        );

        // With displayActiveTiles, a parent and its children are briefly drawn
        // together. Cross-fading stops both being fully opaque at once, which
        // would otherwise z-fight badly.
        if (options.fade !== false) {
            tiles.registerPlugin(
                new TilesFadePlugin({
                    fadeDuration: options.fade?.duration ?? 500,
                    maximumFadeOutTiles: options.fade?.maxFadeOutTiles ?? 100,
                })
            );
        }

        tiles.setCamera(selectionCamera);
        this.updateSelectionResolution();

        // ── Events ───────────────────────────────────────────────────────────
        const kick = () => {
            map.triggerRepaint();
            this.startRepaintLoop();
        };
        tiles.addEventListener('load-tileset', kick);
        tiles.addEventListener('load-model', kick);
        tiles.addEventListener('tiles-load-start', kick);
        tiles.addEventListener('needs-render', kick);
        tiles.addEventListener('load-root-tileset', () => options.onLoadTileset?.());
        tiles.addEventListener('load-error', ({ error, url }) => {
            const err = error instanceof Error ? error : new Error(String(error));
            if (options.onError) options.onError(err, String(url));
            else console.warn(`${LOG_PREFIX} failed to load ${String(url)}:`, err.message);
        });

        scene.add(tiles.group);
        kick();
    }

    render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: RenderInputLike): void {
        const { map, renderer, scene, renderCamera, tiles } = this;
        if (!map || !renderer || !scene || !renderCamera || !tiles) return;
        this.lastRenderAt = performance.now();

        this.updateSelectionResolution();

        // Camera-relative split keeps large ECEF/Mercator numbers off the GPU.
        // See splitCameraRelative() for the precision argument.
        const worldSize = TILE_SIZE * Math.pow(2, map.getZoom());
        const ecefToMerc = ecefToMercatorMatrix(
            this.options.origin.lng,
            this.options.origin.lat,
            this.altitudeOffset,
            worldSize
        );
        const center = map.getCenter();
        const [mx, my] = lngLatToMercator(center.lng, center.lat);
        const { view, projection } = splitCameraRelative(
            args.modelViewProjectionMatrix,
            ecefToMerc,
            mx * worldSize,
            my * worldSize,
            mercatorUnitsPerMetre(this.options.origin.lat, worldSize)
        );
        renderCamera.projectionMatrix.fromArray(projection);
        renderCamera.projectionMatrixInverse.copy(renderCamera.projectionMatrix).invert();
        renderCamera.matrixWorldInverse.fromArray(view);
        renderCamera.matrixWorld.copy(renderCamera.matrixWorldInverse).invert();

        tiles.update();

        const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        if (this.options.clearDepth !== false) {
            // Only depth: the colour buffer still holds the map drawn so far.
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.depthMask(true);
            gl.clear(gl.DEPTH_BUFFER_BIT);
        }
        renderer.resetState();
        renderer.render(scene, renderCamera);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
        renderer.resetState();

        this.reportProgress();
        if (this.hasActiveWork()) this.startRepaintLoop();
    }

    onRemove(): void {
        this.stopRepaintLoop();
        this.tiles?.dispose();
        this.dracoLoader?.dispose();
        this.renderer?.dispose();
        this.tiles = null;
        this.dracoLoader = null;
        this.lruCache = null;
        this.downloadQueue = null;
        this.parseQueue = null;
        this.renderer = null;
        this.scene = null;
        this.selectionCamera = null;
        this.renderCamera = null;
        this.map = null;
        this.lastProgress = -1;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private updateSelectionResolution(): void {
        const { map, tiles, selectionCamera } = this;
        if (!map || !tiles || !selectionCamera) return;
        const canvas = map.getCanvas();
        const k = this.quality.resolutionMultiplier;
        tiles.setResolution(selectionCamera, canvas.width * k, canvas.height * k);
    }

    private reportProgress(): void {
        const { onProgress, debug } = this.options;
        if (!onProgress && !debug) return;
        const stats = this.getStats();
        if (!stats) return;

        if (onProgress && stats.progress !== this.lastProgress) {
            this.lastProgress = stats.progress;
            onProgress(stats.progress, stats);
        }
        if (debug && this.lastRenderAt - this.lastDebugLogAt > 2000) {
            this.lastDebugLogAt = this.lastRenderAt;
            const mb = (stats.cachedBytes / 1024 ** 2).toFixed(1);
            console.log(
                `${LOG_PREFIX} ${this.id}: ${Math.round(stats.progress * 100)}% ` +
                    `queued ${stats.queued}, downloading ${stats.downloading}, parsing ${stats.parsing}, ` +
                    `loaded ${stats.loaded}, failed ${stats.failed}, visible ${stats.visible}, cache ${mb} MB`
            );
        }
    }

    private hasActiveWork(): boolean {
        const { tiles } = this;
        if (!tiles) return false;
        const s = (tiles as unknown as { stats: RendererStats }).stats;
        if (s.queued > 0 || s.downloading > 0 || s.parsing > 0) return true;
        if (this.downloadQueue?.running || this.parseQueue?.running) return true;
        const fade = tiles.getPluginByName('FADE_TILES_PLUGIN') as { fadingTiles?: number } | null;
        return (fade?.fadingTiles ?? 0) > 0;
    }

    /**
     * MapLibre only redraws on interaction. While tiles stream in, keep asking
     * for frames so they appear without the user touching the map, then stop
     * so an idle map costs nothing.
     */
    private startRepaintLoop(): void {
        if (this.repaintTimer || !this.map) return;
        const interval = this.options.repaintInterval ?? 50;
        this.repaintTimer = setInterval(() => {
            const map = this.map;
            // Stop when idle, or when render() is no longer called (layer
            // hidden with visibility: none). render() restarts the loop.
            const stalled = performance.now() - this.lastRenderAt > 1000;
            if (!map || stalled || !this.hasActiveWork()) {
                this.stopRepaintLoop();
                if (map && !stalled) map.triggerRepaint();
                return;
            }
            map.triggerRepaint();
        }, interval);
    }

    private stopRepaintLoop(): void {
        if (this.repaintTimer) {
            clearInterval(this.repaintTimer);
            this.repaintTimer = null;
        }
    }
}

/**
 * Lights for untextured tiles, oriented to the local horizon at `origin`.
 * Tile geometry is in ECEF, so "up" is the ellipsoid normal there rather
 * than a fixed axis, and fixed light positions would point the wrong way.
 */
function addLocalLights(scene: THREE.Scene, origin: LngLat): void {
    const { east, north, up } = enuBasis(origin.lng, origin.lat);
    const centre = new THREE.Vector3(...lngLatToEcef(origin.lng, origin.lat, 0));

    // HemisphereLight shines along its position vector, so pass a direction.
    const sky = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.5);
    sky.position.set(...up);
    scene.add(sky);

    // Sun high in the south-east, offset from the centre so the direction
    // stays exact in Float32.
    const sunDir = new THREE.Vector3(...east)
        .multiplyScalar(0.45)
        .addScaledVector(new THREE.Vector3(...north), -0.35)
        .addScaledVector(new THREE.Vector3(...up), 0.82)
        .normalize();
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.copy(centre).addScaledVector(sunDir, 1000);
    sun.target.position.copy(centre);
    scene.add(sun, sun.target);
}
