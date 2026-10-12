import { describe, expect, it } from 'vitest';
import {
    EARTH_CIRCUMFERENCE,
    TILE_SIZE,
    WGS84_A,
    ecefToLngLat,
    ecefToMercatorMatrix,
    enuBasis,
    lngLatToEcef,
    lngLatToMercator,
    mercatorUnitsPerMetre,
    multiplyMat4,
    splitCameraRelative,
    transformPoint,
    type Vec3,
} from '../src/math';

// Makassar photogrammetry site the layer was built for.
const LNG = 119.4048;
const LAT = -5.1457;
const worldSizeAt = (zoom: number) => TILE_SIZE * 2 ** zoom;

describe('lngLatToEcef / ecefToLngLat', () => {
    it('puts (0, 0) on the equator at the prime meridian', () => {
        const [x, y, z] = lngLatToEcef(0, 0, 0);
        expect(x).toBeCloseTo(WGS84_A, 6);
        expect(y).toBeCloseTo(0, 6);
        expect(z).toBeCloseTo(0, 6);
    });

    it('moves points along the surface normal when altitude changes', () => {
        const a = lngLatToEcef(LNG, LAT, 0);
        const b = lngLatToEcef(LNG, LAT, 100);
        expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeCloseTo(100, 6);
    });

    it('round-trips through ecefToLngLat', () => {
        for (const [lng, lat, alt] of [
            [LNG, LAT, 26.7],
            [-75.6, 40.04, 120],
            [10, 80, 5000],
        ]) {
            const out = ecefToLngLat(...lngLatToEcef(lng, lat, alt));
            expect(out.lng).toBeCloseTo(lng, 9);
            expect(out.lat).toBeCloseTo(lat, 9);
            expect(out.alt).toBeCloseTo(alt, 4);
        }
    });

    it('recovers the Makassar tileset centre from its bounding box', () => {
        // root.boundingVolume.box centre from the original tileset.json
        const { lng, lat } = ecefToLngLat(-3118990.5, 5534239.0, -568236.625);
        expect(lng).toBeCloseTo(119.40477, 4);
        expect(lat).toBeCloseTo(-5.14571, 4);
    });
});

describe('lngLatToMercator', () => {
    it('matches known values', () => {
        expect(lngLatToMercator(-180, 0)[0]).toBe(0);
        expect(lngLatToMercator(0, 0)).toEqual([0.5, 0.5]);
        expect(lngLatToMercator(180, 0)[0]).toBe(1);
        expect(lngLatToMercator(0, 45)[1]).toBeLessThan(0.5); // north is up (smaller y)
    });
});

describe('ecefToMercatorMatrix', () => {
    const ws = worldSizeAt(16);
    const M = ecefToMercatorMatrix(LNG, LAT, 0, ws);
    const centre = transformPoint(M, lngLatToEcef(LNG, LAT, 0));

    it('maps the anchor to its Mercator position at altitude 0', () => {
        const [mx, my] = lngLatToMercator(LNG, LAT);
        expect(centre[0]).toBeCloseTo(mx * ws, 4);
        expect(centre[1]).toBeCloseTo(my * ws, 4);
        expect(centre[2]).toBeCloseTo(0, 4);
        expect(centre[3]).toBe(1);
    });

    it('applies altitudeOffset to Z only', () => {
        const p = transformPoint(ecefToMercatorMatrix(LNG, LAT, 50, ws), lngLatToEcef(LNG, LAT, 0));
        expect(p[0]).toBeCloseTo(centre[0], 4);
        expect(p[1]).toBeCloseTo(centre[1], 4);
        expect(p[2]).toBeCloseTo(50, 4);
    });

    it('outputs Z in metres, linearly', () => {
        const z100 = transformPoint(M, lngLatToEcef(LNG, LAT, 100))[2];
        const z200 = transformPoint(M, lngLatToEcef(LNG, LAT, 200))[2];
        expect(z100).toBeCloseTo(100, 3);
        expect(z200).toBeCloseTo(200, 3);
    });

    it('keeps Z independent of zoom (regression: model stretched upward when zooming)', () => {
        const ecef = lngLatToEcef(LNG, LAT, 100);
        for (const zoom of [10, 16, 20, 22]) {
            const z = transformPoint(ecefToMercatorMatrix(LNG, LAT, 0, worldSizeAt(zoom)), ecef)[2];
            expect(z).toBeCloseTo(100, 3);
        }
    });

    it('scales X/Y linearly with worldSize', () => {
        const east = lngLatToEcef(LNG + 0.001, LAT, 0);
        const dx16 = transformPoint(M, east)[0] - centre[0];
        const M20 = ecefToMercatorMatrix(LNG, LAT, 0, worldSizeAt(20));
        const dx20 = transformPoint(M20, east)[0] - transformPoint(M20, lngLatToEcef(LNG, LAT, 0))[0];
        expect(dx20 / dx16).toBeCloseTo(16, 6);
    });

    it('is conformal: 100 m east and 100 m north have the same length', () => {
        const sH = ws / (EARTH_CIRCUMFERENCE * Math.cos((LAT * Math.PI) / 180));
        const metresPerDegLat = 110_574;
        const metresPerDegLng = 111_320 * Math.cos((LAT * Math.PI) / 180);
        const e = transformPoint(M, lngLatToEcef(LNG + 100 / metresPerDegLng, LAT, 0));
        const n = transformPoint(M, lngLatToEcef(LNG, LAT + 100 / metresPerDegLat, 0));
        const de = Math.hypot(e[0] - centre[0], e[1] - centre[1]);
        const dn = Math.hypot(n[0] - centre[0], n[1] - centre[1]);
        expect(de / (sH * 100)).toBeCloseTo(1, 2);
        expect(dn / (sH * 100)).toBeCloseTo(1, 2);
        expect(n[1]).toBeLessThan(centre[1]); // north decreases Mercator Y
    });

    it('has an orthonormal ENU basis', () => {
        // Column-major: row r of the 3×3 block is [M[r], M[4+r], M[8+r]].
        const row = (r: number) => [M[r], M[4 + r], M[8 + r]];
        const norm = (v: number[]) => Math.hypot(...v);
        const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const E = row(0).map((v) => v / norm(row(0)));
        const N = row(1).map((v) => v / norm(row(1)));
        const U = row(2);
        expect(norm(U)).toBeCloseTo(1, 12);
        expect(dot(E, N)).toBeCloseTo(0, 12);
        expect(dot(E, U)).toBeCloseTo(0, 12);
        expect(dot(N, U)).toBeCloseTo(0, 12);
    });
});

describe('splitCameraRelative', () => {
    const ws = worldSizeAt(18);
    const ecefToMerc = ecefToMercatorMatrix(LNG, LAT, 0, ws);
    const [mx, my] = lngLatToMercator(LNG + 0.0004, LAT - 0.0003);
    const camX = mx * ws;
    const camY = my * ws;
    // An arbitrary non-trivial MVP-like matrix.
    const mvp = [
        0.8, 0.1, 0.02, 0.01,
        -0.2, 0.9, 0.03, 0.02,
        0.05, -0.04, 0.7, 0.3,
        -camX * 0.8, -camY * 0.9, 12, 1500,
    ];

    const zScale = mercatorUnitsPerMetre(LAT, ws);

    it.each([1, zScale])('is mathematically identical to the combined matrix (zScale %f)', (z) => {
        const combined = multiplyMat4(mvp, ecefToMerc);
        const { view, projection } = splitCameraRelative(mvp, ecefToMerc, camX, camY, z);
        const split = multiplyMat4(projection, view);
        for (let i = 0; i < 16; i++) {
            expect(split[i]).toBeCloseTo(combined[i], 6 - Math.ceil(Math.log10(Math.abs(combined[i]) + 1)));
        }
    });

    it('makes view space isotropic with zScale, so lighting is not stretched', () => {
        const { view } = splitCameraRelative(mvp, ecefToMerc, camX, camY, zScale);
        const { east, north, up } = enuBasis(LNG, LAT);
        const c = lngLatToEcef(LNG, LAT, 0);
        const len = (dir: Vec3) => {
            const p = transformPoint(view, [c[0] + dir[0] * 100, c[1] + dir[1] * 100, c[2] + dir[2] * 100]);
            const o = transformPoint(view, c);
            return Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
        };
        expect(len(up) / len(east)).toBeCloseTo(1, 9);
        expect(len(north) / len(east)).toBeCloseTo(1, 9);
    });

    it('leaves the GPU only small camera-relative numbers', () => {
        const { view } = splitCameraRelative(mvp, ecefToMerc, camX, camY);
        const p = transformPoint(view, lngLatToEcef(LNG, LAT, 30));
        // Within a few hundred metres of the camera at zoom 18: |x|, |y| ≪ worldSize.
        expect(Math.abs(p[0])).toBeLessThan(1000);
        expect(Math.abs(p[1])).toBeLessThan(1000);
    });

    it('preserves 10 cm detail in Float32 where the combined matrix loses it', () => {
        const a = lngLatToEcef(LNG, LAT, 0);
        const b = lngLatToEcef(LNG + 0.1 / (111_320 * Math.cos((LAT * Math.PI) / 180)), LAT, 0);
        const exact = transformPoint(ecefToMerc, b)[0] - transformPoint(ecefToMerc, a)[0];

        // Combined: the GPU sees ECEF (~10⁶) inputs and a ~10⁷ translation in Float32.
        const f32 = (m: number[]) => Array.from(new Float32Array(m));
        const f32p = (p: number[]) => p.map(Math.fround) as [number, number, number];
        const combinedErr = Math.abs(
            transformPoint(f32(ecefToMerc), f32p(b))[0] - transformPoint(f32(ecefToMerc), f32p(a))[0] - exact
        );

        // Split: view runs on the CPU in Float64; the GPU only sees its small output.
        const { view } = splitCameraRelative(mvp, ecefToMerc, camX, camY);
        const splitErr = Math.abs(
            Math.fround(transformPoint(view, b)[0]) - Math.fround(transformPoint(view, a)[0]) - exact
        );

        expect(splitErr).toBeLessThan(Math.abs(exact) * 0.01);
        expect(combinedErr).toBeGreaterThan(splitErr * 100);
    });
});
