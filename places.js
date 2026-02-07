import axios from "axios";
import { redis } from "./redis.js";
import "dotenv/config";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CACHE_TTL_SECONDS = 10; // 30 days 2592000
const LOCK_TTL_MS = 15000;       // 15 seconds
const LOCK_WAIT_MS = 200;
const LOCK_MAX_WAIT_MS = 5000;

function roundCoord(value) {
    return Math.floor(value * 1000) / 1000;
}

function makeCacheKey(lat, lng, radius) {
    return `places:v4:${lat}:${lng}:${radius}`;
}

//** Calculate distance between two points in meters using Haversine formula
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
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

export async function getNearbyPlaces({ lat, lng, radius }) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    const cacheKey = makeCacheKey(rLat, rLng, radius);

    console.log("📍 Places request:", { rLat, rLng, radius });

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

        // Strategy 1: Broad search (no type filter)
        let response = await axios.get(
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
            {
                params: {
                    location: `${rLat},${rLng}`,
                    radius,
                    key: GOOGLE_API_KEY
                },
                timeout: 10000
            }
        );

        console.log(`✅ Search returned ${response.data.results?.length || 0} results`);
        console.log(`📊 API Status: ${response.data.status}`);

        // If no results, try larger radius
        if ((!response.data.results || response.data.results.length === 0) && radius < 1000) {
            console.log("🔄 Retrying with 500m radius");

            response = await axios.get(
                "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                {
                    params: {
                        location: `${rLat},${rLng}`,
                        radius: 500,
                        key: GOOGLE_API_KEY
                    },
                    timeout: 10000
                }
            );

            console.log(`✅ Large radius search returned ${response.data.results?.length || 0} results`);
            console.log(`📊 API Status: ${response.data.status}`);
        }

        if (response.data.results && response.data.results.length > 0) {
            // Filter to ONLY food-related places AND major retailers
            const foodTypes = [
                'restaurant',
                'cafe',
                'food',
                'meal_delivery',
                'meal_takeaway',
                'bakery',
                'bar',
                'supermarket',
                'grocery_or_supermarket',
                'store',
                'shopping_mall',
                'convenience_store'
            ];

            // Check by name for major retailers
            const majorRetailers = [
                'walmart supercenter',
                'walmart neighborhood market',
                'target',
                'dollar general',
                'kroger',
                'publix',
                'whole foods',
                'trader joe',
                'aldi',
                'costco',
                'sam\'s club',
                'cvs pharmacy',
                'walgreens'
            ];

            // STRICT FILTER - only food types OR major retailers
            let filteredPlaces = response.data.results.filter(p => {
                // Check if it has food-related types
                const hasFoodType = p.types?.some(t => foodTypes.includes(t));

                // Check if name matches major retailers (exact match on full name)
                const name = (p.name || '').toLowerCase();
                const isMajorRetailer = majorRetailers.some(retailer =>
                    name === retailer || name.startsWith(retailer)
                );

                return hasFoodType || isMajorRetailer;
            });

            console.log(`🍽️ Filtered to ${filteredPlaces.length} food/retail places from ${response.data.results.length} total`);

            // If filter is too strict and returns nothing, fall back to food types only
            if (filteredPlaces.length === 0) {
                console.log("⚠️ Strict filter too restrictive, using food types only");
                filteredPlaces = response.data.results.filter(p => {
                    return p.types?.some(t => foodTypes.includes(t));
                });
            }

            // Map results and calculate distance from user
            const placesWithDistance = filteredPlaces.map(p => {
                const distance = calculateDistance(
                    rLat,
                    rLng,
                    p.geometry.location.lat,
                    p.geometry.location.lng
                );

                return {
                    place_id: p.place_id,
                    name: p.name ?? "",
                    address: p.vicinity ?? p.formatted_address ?? "",
                    lat: p.geometry.location.lat,
                    lng: p.geometry.location.lng,
                    rating: p.rating ?? null,
                    distance: distance
                };
            });

            // Sort by distance (closest first)
            placesWithDistance.sort((a, b) => a.distance - b.distance);

            if (placesWithDistance.length > 0) {
                console.log(`📏 Closest place: ${placesWithDistance[0]?.name} at ${Math.round(placesWithDistance[0]?.distance)}m`);
            }

            // Take top 15 and remove distance field before returning
            places = placesWithDistance.slice(0, 15).map(p => {
                const { distance, ...placeWithoutDistance } = p;
                return placeWithoutDistance;
            });
        }
    } catch (err) {
        console.error("❌ Places API error:", err.message);
        if (err.response) {
            console.error("❌ Error response:", err.response.data);
        }
    }

    // 3️⃣ Fallback if no places
    if (places.length === 0) {
        console.log("⚠️ No food/retail places found, falling back to Geocoding");
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
