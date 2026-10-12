import * as THREE from 'three';

/**
 * - `auto`: textured meshes become unlit (photogrammetry has its lighting
 *   baked into the photos), untextured ones keep their lit glTF material.
 * - `unlit`: every mesh becomes unlit.
 * - `original`: keep the glTF materials as loaded.
 */
export type TileMaterialMode = 'auto' | 'unlit' | 'original';

interface TilePreparePluginOptions {
    material: TileMaterialMode;
    /** Read lazily because the renderer (and its GPU caps) exists only after onAdd. */
    getMaxAnisotropy: () => number;
}

/**
 * 3d-tiles-renderer plugin that prepares every tile scene as it loads.
 *
 * It runs in the `processTileModel` hook rather than on the `load-model`
 * event because the hook fires *before* the renderer records the tile's
 * materials for disposal and before `load-model` is dispatched. That means
 * the replacement materials are disposed with the tile (no GPU leak on LRU
 * eviction), and TilesFadePlugin wraps the replacement, not the original.
 */
export class TilePreparePlugin {
    readonly name = 'MAPLIBRE_TILE_PREPARE_PLUGIN';

    constructor(private readonly options: TilePreparePluginOptions) {}

    processTileModel(scene: THREE.Object3D): void {
        const anisotropy = this.options.getMaxAnisotropy();
        const mode = this.options.material;

        scene.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh || !mesh.material) return;

            const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const prepared = sources.map((src) => {
                const map = (src as THREE.MeshStandardMaterial).map ?? null;
                if (map) sharpenTexture(map, anisotropy);
                const unlit = mode === 'unlit' || (mode === 'auto' && map !== null);
                if (!unlit) return src;

                // The new material reuses the texture, so only the material
                // itself is released here.
                const replacement = toUnlit(src, map);
                src.dispose();
                return replacement;
            });
            mesh.material = Array.isArray(mesh.material) ? prepared : prepared[0];
        });
    }
}

/**
 * Photogrammetry has lighting baked into its textures, so an unlit material
 * shows it as captured and is cheaper to shade.
 *
 * FrontSide hides the inward-facing tile "skirts" that otherwise show up as
 * shattered layers from oblique angles. polygonOffset is deliberately not
 * used: depth bias makes overlapping LODs visibly separate at grazing angles,
 * which looks worse than the z-fighting it is meant to fix.
 */
function toUnlit(src: THREE.Material, map: THREE.Texture | null): THREE.MeshBasicMaterial {
    const s = src as THREE.MeshStandardMaterial;
    return new THREE.MeshBasicMaterial({
        map,
        color: s.color ?? 0xffffff,
        vertexColors: s.vertexColors,
        transparent: s.transparent,
        opacity: s.opacity,
        alphaTest: s.alphaTest,
        side: THREE.FrontSide,
        depthWrite: true,
        depthTest: true,
    });
}

/**
 * Anisotropic filtering keeps textures sharp when viewed at oblique angles,
 * which is how a pitched map camera sees almost everything.
 */
function sharpenTexture(texture: THREE.Texture, anisotropy: number): void {
    texture.anisotropy = anisotropy;
    if (!(texture as THREE.CompressedTexture).isCompressedTexture) {
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
    }
    if (texture.image) texture.needsUpdate = true;
}
