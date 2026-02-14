import axios from "axios";
import { redis } from "./redis.js";
import "dotenv/config";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CACHE_TTL_SECONDS = 2592000; // 30 days
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

    // 2️⃣ Search and filter
    let places = [];

    try {
        console.log("🌐 CALLING GOOGLE PLACES NEARBY");

        // Food types for filtering
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

        // Major retailers for filtering
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

        // Helper function to filter results
        const filterPlaces = (results) => {
            return results.filter(p => {
                const hasFoodType = p.types?.some(t => foodTypes.includes(t));
                const name = (p.name || '').toLowerCase();
                const isMajorRetailer = majorRetailers.some(retailer =>
                    name === retailer || name.startsWith(retailer)
                );
                return hasFoodType || isMajorRetailer;
            });
        };

            // Initial search with 100m radius (ignore radius from Android)
            let response = await axios.get(
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
            {
                params: {
                    location: `${rLat},${rLng}`,
                    radius: 100,  // CHANGED from radius to 100
                    key: GOOGLE_API_KEY
                },
                timeout: 10000
            }
        );

        console.log(`✅ 100m search returned ${response.data.results?.length || 0} results`); || 0} results`);
        console.log(`📊 API Status: ${response.data.status}`);

        let filteredPlaces = [];
        
        if (response.data.results && response.data.results.length > 0) {
            filteredPlaces = filterPlaces(response.data.results);
            console.log(`🍽️ Filtered to ${filteredPlaces.length} food/retail places from ${response.data.results.length} total`);
        }

        // If no food/retail places found, expand to 200m
        if (filteredPlaces.length === 0) {
            console.log("🔄 No food/retail places in 100m, expanding to 200m");

            response = await axios.get(
                "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                {
                    params: {
                        location: `${rLat},${rLng}`,
                        radius: 200,  // CHANGED from 500 to 200
                        key: GOOGLE_API_KEY
                    },
                    timeout: 10000
                }
            );

            console.log(`✅ 200m search returned ${response.data.results?.length || 0} results`);
            console.log(`📊 API Status: ${response.data.status}`);

            if (response.data.results && response.data.results.length > 0) {
                filteredPlaces = filterPlaces(response.data.results);
                console.log(`🍽️ Filtered to ${filteredPlaces.length} food/retail places from ${response.data.results.length} total`);
            }
        }

        // If we have filtered results, sort by distance and return
        if (filteredPlaces.length > 0) {
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

            console.log(`📏 Closest place: ${placesWithDistance[0]?.name} at ${Math.round(placesWithDistance[0]?.distance)}m`);

            // Take top 10 and remove distance field before returning
            places = placesWithDistance.slice(0, 10).map(p => {
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
