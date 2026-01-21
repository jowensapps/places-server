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

    console.log("📍 Places request:", { rLat, rLng, radius, type });

    // 1️⃣ Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log("🟢 CACHE HIT");
        return JSON.parse(cached);
    }

    console.log("❌ CACHE MISS");

    // 2️⃣ Try multiple search strategies
    let places = [];

    try {
        console.log("🌐 CALLING GOOGLE PLACES NEARBY");

        // Strategy 1: Search with specified type
        let response = await axios.get(
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
            {
                params: {
                    location: `${rLat},${rLng}`,
                    radius,
                    type,
                    key: GOOGLE_API_KEY
                },
                timeout: 10000
            }
        );

        console.log(`✅ Type search (${type}) returned ${response.data.results?.length || 0} results`);

        // If type search fails, try without type filter (get everything nearby)
        if (!response.data.results || response.data.results.length === 0) {
            console.log("🔄 Retrying without type filter");

            response = await axios.get(
                "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                {
                    params: {
                        location: `${rLat},${rLng}`,
                        radius: Math.max(radius, 200), // Increase radius to at least 200m
                        key: GOOGLE_API_KEY
                    },
                    timeout: 10000
                }
            );

            console.log(`✅ No-filter search returned ${response.data.results?.length || 0} results`);
        }

        if (response.data.results && response.data.results.length > 0) {
            // Filter to prefer food-related places, but include others if needed
            const foodTypes = ['restaurant', 'cafe', 'food', 'meal_delivery', 'meal_takeaway', 'bakery', 'bar'];

            let foodPlaces = response.data.results.filter(p =>
                p.types?.some(t => foodTypes.includes(t))
            );

            // If no food places, use all results
            const resultsToUse = foodPlaces.length > 0 ? foodPlaces : response.data.results;

            console.log(`🍽️ Using ${resultsToUse.length} results (${foodPlaces.length} food-related)`);

            places = resultsToUse.slice(0, 10).map(p => ({
                place_id: p.place_id,
                name: p.name ?? "",
                // Use vicinity for nearby search, it's more reliable than formatted_address
                address: p.vicinity ?? p.formatted_address ?? "",
                lat: p.geometry.location.lat,
                lng: p.geometry.location.lng,
                rating: p.rating ?? null
            }));
        }
    } catch (err) {
        console.error("❌ Places API error:", err.message);
    }

    // 3️⃣ Fallback if no places
    if (places.length === 0) {
        console.log("⚠️ All searches returned 0 results, falling back to Geocoding");
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
    console.log(`💾 CACHING ${places.length} places`);
    await redis.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(places));
    return places;
}