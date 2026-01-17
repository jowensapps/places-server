import axios from "axios";
import { redis } from "./redis.js";
import "dotenv/config";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const CACHE_TTL_SECONDS = 21600; // 6 hours
const LOCK_TTL_MS = 15000;       // 15 seconds
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
        PX: LOCK_TTL_MS
    });
}

export async function getNearbyPlaces({ lat, lng, radius, type }) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    const cacheKey = makeCacheKey(rLat, rLng, radius, type);
    const lockKey = `lock:${cacheKey}`;

    console.log("📍 Request received:", { lat, lng, radius, type });
    console.log("🔑 Cache key:", cacheKey);

    // 1️⃣ Cache check
    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log("✅ CACHE HIT");
        return JSON.parse(cached);
    }

    console.log("❌ CACHE MISS");

    // 2️⃣ Lock attempt
    const lockAcquired = await acquireLock(lockKey);

    if (!lockAcquired) {
        console.log("⏳ LOCK HELD — waiting");

        const start = Date.now();
        while (Date.now() - start < LOCK_MAX_WAIT_MS) {
            await sleep(LOCK_WAIT_MS);
            const retry = await redis.get(cacheKey);
            if (retry) {
                console.log("🔁 CACHE FILLED BY OTHER REQUEST");
                return JSON.parse(retry);
            }
        }

        throw new Error("Lock timeout waiting for cache fill");
    }

    console.log("🔒 LOCK ACQUIRED — calling Google");

    // 3️⃣ Google Places call
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

    // 4️⃣ Cache result
    await redis.setEx(
        cacheKey,
        CACHE_TTL_SECONDS,
        JSON.stringify(places)
    );

    // 5️⃣ Release lock
    await redis.del(lockKey);

    console.log("💾 CACHE STORED — lock released");

    return places;
}

export async function getNearbyPlacesHandler(req, res) {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const radius = Number(req.query.radius ?? 100);
        const type = req.query.type ?? "restaurant";

        if (!lat || !lng) {
            return res.status(400).json({ error: "Missing lat/lng" });
        }

        const places = await getNearbyPlaces({
            lat,
            lng,
            radius,
            type
        });

        res.json(places);
    } catch (err) {
        console.error("❌ Nearby places failed:", err);
        res.status(500).json([]);
    }
}
