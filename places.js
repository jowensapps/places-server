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

async function fetchGeocodingFallback(lat, lng) {
    const offsets = [
        [0, 0],
        [0.0001, 0],
        [-0.0001, 0],
        [0, 0.0001],
        [0, -0.0001],
        [0.0001, 0.0001],
        [-0.0001, 0.0001],
        [0.0001, -0.0001],
        [-0.0001, -0.0001],
    ];

    const client = axios.create();
    const results = [];

    for (const [latOffset, lngOffset] of offsets) {
        const rLat = lat + latOffset;
        const rLng = lng + lngOffset;

        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${rLat},${rLng}&key=${GOOGLE_API_KEY}`;

        const response = await client.get(url);
        const body = response.data;

        if (body?.results?.length > 0) {
            const formattedAddress = body.results[0].formatted_address;
            results.push({ name: "", address: formattedAddress });
        }

        if (results.length >= 10) break;
    }

    return results;
}

export async function getNearbyPlaces({ lat, lng, radius, type }) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    const cacheKey = makeCacheKey(rLat, rLng, radius, type);

    // 1️⃣ Check cache
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 2️⃣ Call Google Places Nearby
    let places = [];
    try {
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

        places = response.data.results.map(p => ({
            name: p.name,
            address: "", // Nearby Search does not return formatted address
            lat: p.geometry.location.lat,
            lng: p.geometry.location.lng,
            rating: p.rating ?? null
        }));
    } catch (err) {
        console.error("Places API error:", err);
    }

    // 3️⃣ Fallback if no places
    if (places.length === 0) {
        console.log("⚠️ Nearby search returned 0 results, falling back to Geocoding");
        const fallbackResults = await fetchGeocodingFallback(lat, lng);
        places = fallbackResults.map(p => ({
            name: p.name,
            address: p.address,
            lat,
            lng,
            rating: null
        }));
    }

    // 4️⃣ Cache and return
    await redis.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(places));
    return places;
}
