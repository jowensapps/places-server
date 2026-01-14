import axios from "axios";
import { redis } from "./redis.js";

const GOOGLE_API_KEY = "AIzaSyDoTlW2p1Hy1kOFcSCR4LyhV4y5i9Czm7E";
const CACHE_TTL_SECONDS = 21600; // 6 hours

const LOCK_TTL_SECONDS = 10;
const LOCK_WAIT_MS = 200;
const LOCK_MAX_WAIT_MS = 5000;

function roundCoord(value) {
    return Math.floor(value * 1000) / 1000;
}

function makeCacheKey(lat, lng, radius, type) {
    return `places:${lat}:${lng}:${radius}:${type}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireLock(lockKey) {
    return await redis.set(lockKey, "1", {
        NX: true,
        EX: LOCK_TTL_SECONDS
    });
}

export async function getNearbyPlaces({ lat, lng, radius, type }) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    const cacheKey = makeCacheKey(rLat, rLng, radius, type);
    const lockKey = `lock:${cacheKey}`;
    console.log("📍 Request received:", { lat, lng, radius, type });
    console.log("🔑 Using cache key:", cacheKey);

    // 1️⃣ Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log("O CACHE HIT for", cacheKey);
        return JSON.parse(cached);
    } else {
        console.log("X CACHE MISS for", cacheKey);
    }

    // 2️⃣ Try to acquire lock
    const lockAcquired = await acquireLock(lockKey);

    if (!lockAcquired) {
        console.log("🟡 LOCK HELD — waiting for cache", lockKey);

        const start = Date.now();
        while (Date.now() - start < LOCK_MAX_WAIT_MS) {
            await sleep(LOCK_WAIT_MS);

            const retryCache = await redis.get(cacheKey);
            if (retryCache) {
                console.log("🟢 CACHE HIT (after wait)");
                return JSON.parse(retryCache);
            }
        }

        console.log("🔴 LOCK TIMEOUT — calling Google anyway");
    } else {
        console.log("🔒 LOCK ACQUIRED");
    }

    // 3️⃣ Call Google Places
    console.log("🔴 CALLING GOOGLE for", cacheKey);
    const response = await axios.get(
        "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
        {
            params: {
                location: `${rLat},${rLng}`,
                radius,
                type,
                key: GOOGLE_API_KEY
            }
        }
    );

    const places = response.data.results.map(p => ({
        place_id: p.place_id,
        name: p.name,
        lat: p.geometry.location.lat,
        lng: p.geometry.location.lng,
        rating: p.rating ?? null
    }));

    // 4️⃣ Cache results
    await redis.setEx(
        cacheKey,
        CACHE_TTL_SECONDS,
        JSON.stringify(places)
    );

    // 5️⃣ Release lock (best-effort)
    await redis.del(lockKey);

    return places;
}
