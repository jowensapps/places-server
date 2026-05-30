import axios from "axios";
import { redis } from "./redis.js";
import "dotenv/config";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CACHE_TTL_SECONDS = 2592000; // 30 days

function roundCoord(value) {
    return Math.floor(value * 1000) / 1000;
}

function makeCacheKey(lat, lng, groceryMode, allPlaces) {
    const mode = allPlaces === 'true' || allPlaces === true ? 'all'
        : groceryMode === 'true' || groceryMode === true ? 'grocery' : 'normal';
    return `places:v15:${lat}:${lng}:${mode}`;
}

/** Calculate distance between two points in meters using Haversine formula */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/** Reverse geocode with offsets as a fallback when no places are found */
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

/**
 * Call the Places (New) API searchNearby endpoint.
 * Returns the raw `places` array from the response.
 */
async function searchNearby(lat, lng, radiusMeters) {
    const response = await axios.post(
        "https://places.googleapis.com/v1/places:searchNearby",
        {
            maxResultCount: 20,
            locationRestriction: {
                circle: {
                    center: {
                        latitude: lat,
                        longitude: lng
                    },
                    radius: radiusMeters
                }
            }
        },
        {
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_API_KEY,
                "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types"
            },
            timeout: 10000
        }
    );

    return response.data.places || [];
}

export async function getNearbyPlaces({ lat, lng, groceryMode, allPlaces }) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    const cacheKey = makeCacheKey(rLat, rLng, groceryMode, allPlaces);

    console.log("📍 Places request:", { rLat, rLng, groceryMode });

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
        console.log("🌐 CALLING GOOGLE PLACES (NEW) NEARBY");

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
            'walgreens',
            'home depot',
            'lowe\'s'
        ];

        // Blacklisted keywords — exclude any place containing these words
        const blacklistKeywords = [
            'pharmacy',
            'auto care',
            'vision center',
            'tire center',
            'optical'
        ];

        // Food-related keywords — matches any Google type containing these
        const foodKeywords = [
            'restaurant', 'cafe', 'bakery', 'bar', 'food', 'shop',
            'meal', 'supermarket', 'grocery', 'store', 'mall', 'convenience'
        ];

        // Helper function to filter results based on mode
        const filterPlaces = (results) => {
            return results.filter(p => {
                const name = (p.displayName?.text || '').toLowerCase();

                // All places mode: skip filtering, return all named places
                if (allPlaces === 'true' || allPlaces === true) {
                    return name.length > 0;
                }

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

                // NORMAL MODE: Food-related types OR major retailers
                const hasFoodType = p.types?.some(t =>
                    foodKeywords.some(kw => t.includes(kw))
                );
                return hasFoodType || isMajorRetailer;
            });
        };

        // Initial search with 250m radius
        let rawPlaces = await searchNearby(rLat, rLng, 250.0);
        console.log(`✅ 250m search returned ${rawPlaces.length} results`);

        let filteredPlaces = [];

        if (rawPlaces.length > 0) {
            filteredPlaces = filterPlaces(rawPlaces);
            console.log(`🍽️ Filtered to ${filteredPlaces.length} places from ${rawPlaces.length} total`);
        }

        // If no places found, expand search to 500m
        if (filteredPlaces.length === 0) {
            console.log("🔄 No places in 100m, expanding to 500m");

            rawPlaces = await searchNearby(rLat, rLng, 500.0);
            console.log(`✅ 500m search returned ${rawPlaces.length} results`);

            if (rawPlaces.length > 0) {
                filteredPlaces = filterPlaces(rawPlaces);
                console.log(`🍽️ Filtered to ${filteredPlaces.length} places from ${rawPlaces.length} total`);
            }
        }

        // If we have filtered results, sort and return
        if (filteredPlaces.length > 0) {
            const placesWithDistance = filteredPlaces.map(p => {
                const distance = calculateDistance(
                    rLat, rLng,
                    p.location.latitude,
                    p.location.longitude
                );

                const nameLower = (p.displayName?.text || '').toLowerCase();

                return {
                    place_id: p.id,
                    name: p.displayName?.text ?? "",
                    address: p.shortFormattedAddress ?? p.formattedAddress ?? "",
                    lat: p.location.latitude,
                    lng: p.location.longitude,
                    distance: distance,
                    isMajorRetailer: majorRetailers.some(r =>
                        nameLower === r || nameLower.startsWith(r)
                    )
                };
            });

            // Sort: Major retailers first, then by distance
            placesWithDistance.sort((a, b) => {
                if (a.isMajorRetailer && !b.isMajorRetailer) return -1;
                if (!a.isMajorRetailer && b.isMajorRetailer) return 1;
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

    // Fallback if no places found
    if (places.length === 0) {
        console.log("⚠️ No places found, falling back to Geocoding");
        const fallbackResults = await fetchGeocodingFallback(lat, lng);
        places = fallbackResults.map(p => ({
            name: p.name,
            address: p.address,
            lat,
            lng
        }));
    }

    // Cache and return
    console.log(`💾 CACHING ${places.length} places`);
    await redis.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(places));
    return places;
}
