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

function makeCacheKey(lat, lng, radius, groceryMode) {
    const mode = groceryMode === 'true' || groceryMode === true ? 'grocery' : 'normal';
    return `places:v5:${lat}:${lng}:${radius}:${mode}`;
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

export async function getNearbyPlaces({ lat, lng, radius, groceryMode }) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    const cacheKey = makeCacheKey(rLat, rLng, radius, groceryMode);

    console.log("📍 Places request:", { rLat, rLng, radius, groceryMode });

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

        // Food types for filtering (only used in non-grocery mode)
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
            'cvs',
            'walgreens'
        ];
        
        // Blacklisted keywords - exclude any place containing these words
        const blacklistKeywords = [
            'pharmacy',
            'auto care',
            'vision center',
            'tire center',
            'optical'
        ];
                
        // Helper function to filter results based on mode
        const filterPlaces = (results) => {
            return results.filter(p => {
                const name = (p.name || '').toLowerCase();
                
                // Check if name contains any blacklisted keywords
                const isBlacklisted = blacklistKeywords.some(keyword =>
                    name.includes(keyword)
                );
                if (isBlacklisted) return false;
                
                const isMajorRetailer = majorRetailers.some(retailer =>
                    name === retailer || name.startsWith(retailer)
                );

                // GROCERY MODE: Only major retailers
                if (groceryMode === 'true' || groceryMode === true) {
                    return isMajorRetailer;
                }

                // NORMAL MODE: Food types OR major retailers
                const hasFoodType = p.types?.some(t => foodTypes.includes(t));
                return hasFoodType || isMajorRetailer;
            });
        };

        // Initial search with 100m radius
        let response = await axios.get(
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
            {
                params: {
                    location: `${rLat},${rLng}`,
                    radius: 100,
                    key: GOOGLE_API_KEY
                },
                timeout: 10000
            }
        );

        const modeLabel = (groceryMode === 'true' || groceryMode === true) ? 'GROCERY' : 'NORMAL';
        console.log(`✅ 100m search returned ${response.data.results?.length || 0} results (${modeLabel} mode)`);
        console.log(`📊 API Status: ${response.data.status}`);

        let filteredPlaces = [];
        
        if (response.data.results && response.data.results.length > 0) {
            filteredPlaces = filterPlaces(response.data.results);
            console.log(`🍽️ Filtered to ${filteredPlaces.length} places from ${response.data.results.length} total`);
        }

        // If no places found, expand search to 200m
        if (filteredPlaces.length === 0) {
            console.log("🔄 No places in 100m, expanding to 200m");

            response = await axios.get(
                "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                {
                    params: {
                        location: `${rLat},${rLng}`,
                        radius: 200,
                        key: GOOGLE_API_KEY
                    },
                    timeout: 10000
                }
            );

            console.log(`✅ 200m search returned ${response.data.results?.length || 0} results`);
            console.log(`📊 API Status: ${response.data.status}`);

            if (response.data.results && response.data.results.length > 0) {
                filteredPlaces = filterPlaces(response.data.results);
                console.log(`🍽️ Filtered to ${filteredPlaces.length} places from ${response.data.results.length} total`);
            }
        }

        // If we have filtered results, sort and return
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
                    distance: distance,
                    isMajorRetailer: majorRetailers.some(r => 
                        (p.name || '').toLowerCase() === r || 
                        (p.name || '').toLowerCase().startsWith(r)
                    )
                };
            });

            // Sort: Major retailers first, then by distance
            placesWithDistance.sort((a, b) => {
                // Major retailers come first
                if (a.isMajorRetailer && !b.isMajorRetailer) return -1;
                if (!a.isMajorRetailer && b.isMajorRetailer) return 1;
                
                // Otherwise sort by distance
                return a.distance - b.distance;
            });

            if (placesWithDistance.length > 0) {
                console.log(`📏 Closest place: ${placesWithDistance[0]?.name} at ${Math.round(placesWithDistance[0]?.distance)}m`);
            }

            // Take top 10 and remove helper fields
            places = placesWithDistance.slice(0, 10).map(p => {
                const { distance, isMajorRetailer, ...placeWithoutDistance } = p;
                return placeWithoutDistance;
            });
        }
    } catch (err) {
        console.error("❌ Places API error:", err.message);
        if (err.response) {
            console.error("❌ Error response:", err.response.data);
        }
    }

    // Fallback if no places
    if (places.length === 0) {
        console.log("⚠️ No places found, falling back to Geocoding");
        const fallbackResults = await fetchGeocodingFallback(lat, lng);
        places = fallbackResults.map(p => ({
            name: p.name,
            address: p.address,
            lat,
            lng,
            rating: null
        }));
    }

    // Cache and return
    console.log(`💾 CACHING ${places.length} places`);
    await redis.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(places));
    return places;
}
