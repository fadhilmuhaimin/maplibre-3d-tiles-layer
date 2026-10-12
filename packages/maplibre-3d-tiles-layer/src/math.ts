/*
 * Pure geodesy / projection math for placing ECEF 3D Tiles on a MapLibre map.
 *
 * No three.js or MapLibre imports, so everything here runs in Node and is
 * covered by unit tests. Matrices are 16-element arrays in column-major order,
 * the layout used by three.js `Matrix4.elements`, gl-matrix and WebGL.
 */

export type Vec3 = [number, number, number];
export type Mat4 = number[];

export interface LngLat {
    lng: number;
    lat: number;
}

export interface LngLatAlt extends LngLat {
    alt: number;
}

/** Equatorial circumference used by MapLibre's Web Mercator (metres). */
export const EARTH_CIRCUMFERENCE = 40_075_016.686;
/** WGS84 semi-major axis (metres). */
export const WGS84_A = 6_378_137.0;
/** WGS84 first eccentricity squared. */
export const WGS84_E2 = 0.006_694_379_990_14;

/** MapLibre's tile size at zoom 0; `worldSize = TILE_SIZE * 2^zoom`. */
export const TILE_SIZE = 512;

const DEG = Math.PI / 180;

/** Geodetic WGS84 longitude/latitude/altitude → ECEF (metres). */
export function lngLatToEcef(lng: number, lat: number, alt = 0): Vec3 {
    const λ = lng * DEG;
    const φ = lat * DEG;
    const sinφ = Math.sin(φ);
    const cosφ = Math.cos(φ);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinφ * sinφ);
    return [
        (N + alt) * cosφ * Math.cos(λ),
        (N + alt) * cosφ * Math.sin(λ),
        (N * (1 - WGS84_E2) + alt) * sinφ,
    ];
}

/**
 * ECEF (metres) → geodetic WGS84. Iterative; converges to sub-millimetre
 * accuracy within a few steps for points near the Earth's surface.
 */
export function ecefToLngLat(x: number, y: number, z: number): LngLatAlt {
    const p = Math.hypot(x, y);
    const lng = Math.atan2(y, x);
    let lat = Math.atan2(z, p * (1 - WGS84_E2));
    let alt = 0;
    for (let i = 0; i < 8; i++) {
        const sinφ = Math.sin(lat);
        const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinφ * sinφ);
        alt = p / Math.cos(lat) - N;
        lat = Math.atan2(z, p * (1 - (WGS84_E2 * N) / (N + alt)));
    }
    return { lng: lng / DEG, lat: lat / DEG, alt };
}

/** Unit East/North/Up vectors (in ECEF) of the local tangent plane at a point. */
export function enuBasis(lng: number, lat: number): { east: Vec3; north: Vec3; up: Vec3 } {
    const λ = lng * DEG;
    const φ = lat * DEG;
    const sinλ = Math.sin(λ), cosλ = Math.cos(λ);
    const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
    return {
        east: [-sinλ, cosλ, 0],
        north: [-sinφ * cosλ, -sinφ * sinλ, cosφ],
        up: [cosφ * cosλ, cosφ * sinλ, sinφ],
    };
}

/**
 * Mercator world units per metre at a latitude. Equal to MapLibre's
 * `pixelsPerMeter` and to the horizontal scale of `ecefToMercatorMatrix`.
 */
export function mercatorUnitsPerMetre(lat: number, worldSize: number): number {
    return worldSize / (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG));
}

/** Longitude/latitude → MapLibre Mercator coordinates normalised to [0, 1]. */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
    const x = (lng + 180) / 360;
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) / Math.PI) / 2;
    return [x, y];
}

/**
 * Build the matrix that maps ECEF positions into the space expected by
 * MapLibre's `modelViewProjectionMatrix`:
 *
 *   X, Y → worldSize-scaled Mercator (range [0, worldSize])
 *   Z    → altitude in metres. MapLibre's MVP already scales Z by
 *          pixelsPerMeter internally, so Z must NOT be multiplied by
 *          worldSize here, or the model stretches upward quadratically
 *          with zoom.
 *
 * The mapping is a local tangent-plane (East-North-Up) approximation at
 * (lng0, lat0), so it is accurate for site/city-scale tilesets near that
 * point. Mercator is conformal, so East and North share one scale factor.
 */
export function ecefToMercatorMatrix(
    lng0: number,
    lat0: number,
    altitudeOffset: number,
    worldSize: number
): Mat4 {
    const {
        east: [Ex, Ey, Ez],
        north: [Nx, Ny, Nz],
        up: [Ux, Uy, Uz],
    } = enuBasis(lng0, lat0);

    // Horizontal scale: ECEF metres → worldSize-scaled Mercator.
    const sH = mercatorUnitsPerMetre(lat0, worldSize);

    const [Cx, Cy, Cz] = lngLatToEcef(lng0, lat0, 0);
    const [mx0, my0] = lngLatToMercator(lng0, lat0);

    // Translation so the tangent point C lands on (mx0, my0, altitudeOffset).
    // Mercator Y grows southward, hence the flipped North row.
    const tx = mx0 * worldSize - sH * (Ex * Cx + Ey * Cy + Ez * Cz);
    const ty = my0 * worldSize + sH * (Nx * Cx + Ny * Cy + Nz * Cz);
    const tz = -(Ux * Cx + Uy * Cy + Uz * Cz) + altitudeOffset;

    // Column-major.
    return [
        sH * Ex, -sH * Nx, Ux, 0,
        sH * Ey, -sH * Ny, Uy, 0,
        sH * Ez, -sH * Nz, Uz, 0,
        tx,      ty,       tz, 1,
    ];
}

/**
 * GPU precision fix — split one ECEF→clip transform into two matrices.
 *
 * Feeding `mvp × ecefToMerc` to the GPU as a single matrix makes the vertex
 * shader subtract numbers around 10⁷ in Float32 (~7 significant digits), so
 * metre-level detail is lost: fragmented edges, floating geometry, depth
 * shimmer. Instead we subtract the camera's Mercator position on the CPU in
 * Float64 (`view`), leaving the GPU with small camera-relative values, and
 * add it back inside the projection (`projection`). The product is unchanged:
 *
 *   projection × view = mvp × T(cam) × (ecefToMerc − T(cam)) = mvp × ecefToMerc
 *
 * Use `view` as the camera's matrixWorldInverse and `projection` as its
 * projectionMatrix.
 *
 * `zScale` (pass `mercatorUnitsPerMetre`) additionally moves MapLibre's
 * metres→Mercator Z scaling from the projection into the view, so view space
 * has the same units on every axis. three.js computes lighting in view space
 * and assumes it is not stretched; without this, lit materials shade
 * differently at every zoom level. It does not change the product either:
 *
 *   projection = mvp × T(cam) × S⁻¹,  view = S × (ecefToMerc − T(cam))
 */
export function splitCameraRelative(
    mvp: ArrayLike<number>,
    ecefToMerc: Mat4,
    camMercX: number,
    camMercY: number,
    zScale = 1
): { view: Mat4; projection: Mat4 } {
    const view = ecefToMerc.slice();
    view[12] -= camMercX;
    view[13] -= camMercY;
    // S × view scales the Z row.
    for (let col = 0; col < 4; col++) view[col * 4 + 2] *= zScale;

    // projection = mvp × translate(camMercX, camMercY, 0) × S⁻¹.
    // The translation only changes the last column, S⁻¹ only the third.
    const projection = Array.from(mvp);
    for (let row = 0; row < 4; row++) {
        projection[12 + row] = mvp[row] * camMercX + mvp[4 + row] * camMercY + mvp[12 + row];
        projection[8 + row] = mvp[8 + row] / zScale;
    }
    return { view, projection };
}

/** Column-major 4×4 multiply, `a × b`. */
export function multiplyMat4(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
    const out = new Array<number>(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

/** Column-major matrix × [x, y, z, 1], returning [x, y, z, w]. */
export function transformPoint(m: ArrayLike<number>, p: Vec3): [number, number, number, number] {
    const [x, y, z] = p;
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
        m[3] * x + m[7] * y + m[11] * z + m[15],
    ];
}
