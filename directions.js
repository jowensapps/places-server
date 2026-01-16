import axios from "axios";
import { redis } from "./redis.js";
import "dotenv/config";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Cache + locking config
const CACHE_TTL_SECONDS = 86400; // 24 hours
const LOCK_TTL_SECONDS = 10;
const LOCK_WAIT_MS = 200;
const LOCK_MAX_WAIT_MS = 5000;

/**
 * Round coordinates to increase cache hit rate
 */
function roundCoord(value) {
    return Math.floor(value * 1000) / 1000;
}

/**
 * Cache key builder
 */
function makeCacheKey(oLat, oLng, dLat, dLng) {
    return `directions:${oLat}:${oLng}:${dLat}:${dLng}`;
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Acquire Redis lock
 */
async function acquireLock(lockKey) {
    return await redis.set(lockKey, "1", {
        NX: true,
        EX: LOCK_TTL_SECONDS
    });
}

/**
 * Straight-line fallback distance (miles)
 */
function straightLineMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Main exported function
 */
export async function getDirectionsDistance({
    originLat,
    originLng,
    destLat,
    destLng
}) {
    const oLat = roundCoord(originLat);
    const oLng = roundCoord(originLng);
    const dLat = roundCoord(destLat);
    const dLng = roundCoord(destLng);

    const cacheKey = makeCacheKey(oLat, oLng, dLat, dLng);
    const lockKey = `lock:${cacheKey}`;

    console.log("📏 Directions request:", { oLat, oLng, dLat, dLng });
    console.log("🔑 Cache key:", cacheKey);

    // 1️. Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log("🟢 CACHE HIT");
        return {
            distance_miles: Number(cached),
            source: "cache"
        };
    }

    console.log("❌ CACHE MISS");

    // 2️. Acquire lock
    const lockAcquired = await acquireLock(lockKey);

    if (!lockAcquired) {
        console.log("🟡 LOCK HELD — waiting");

        const start = Date.now();
        while (Date.now() - start < LOCK_MAX_WAIT_MS) {
            await sleep(LOCK_WAIT_MS);

            const retry = await redis.get(cacheKey);
            if (retry) {
                console.log("🟢 CACHE HIT (after wait)");
                return {
                    distance_miles: Number(retry),
                    source: "cache"
                };
            }
        }

        console.log("🔴 LOCK TIMEOUT — proceeding anyway");
    } else {
        console.log("🔒 LOCK ACQUIRED");
    }

    // 3️. Call Google Directions
    try {
        console.log("🌐 CALLING GOOGLE DIRECTIONS");

        const response = await axios.get(
            "https://maps.googleapis.com/maps/api/directions/json",
            {
                params: {
                    origin: `${oLat},${oLng}`,
                    destination: `${dLat},${dLng}`,
                    key: GOOGLE_API_KEY
                },
                timeout: 10000
            }
        );

        const routes = response.data.routes;

        if (routes.length > 0) {
            const meters = routes[0].legs[0].distance.value;
            const miles = meters * 0.000621371;

            await redis.setEx(cacheKey, CACHE_TTL_SECONDS, miles.toString());
            await redis.del(lockKey);

            console.log("✅ GOOGLE SUCCESS — cached");

            return {
                distance_miles: miles,
                source: "google"
            };
        }

        throw new Error("No routes returned");

    } catch (err) {
        console.error("❌ GOOGLE FAILED:", err.message);

        const fallback = straightLineMiles(oLat, oLng, dLat, dLng);

        await redis.setEx(cacheKey, CACHE_TTL_SECONDS, fallback.toString());
        await redis.del(lockKey);

        console.log("🟠 FALLBACK DISTANCE USED");

        return {
            distance_miles: fallback,
            source: "fallback"
        };
    }
}
