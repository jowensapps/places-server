import express from "express";
import cors from "cors";
import "dotenv/config";

import { getNearbyPlaces } from "./places.js";
import { getDirectionsDistance } from "./directions.js";
import "./redis.js";

const app = express();

app.use(cors());
app.use(express.json());

/**
 * Health check (used by UptimeRobot)
 */
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

/**
 * Places Nearby endpoint
 *
 * Example:
 * /places?lat=33.749&lng=-84.388
 * /places?lat=33.749&lng=-84.388&radius=500&type=restaurant
 */
app.get("/places", async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);

        // Optional params with safe defaults
        const radius = Number(req.query.radius ?? 100);
        const type = req.query.type ?? "restaurant";

        if (!lat || !lng) {
            return res.status(400).json({
                error: "Missing required query parameters: lat, lng"
            });
        }

        const places = await getNearbyPlaces({
            lat,
            lng,
            radius,
            type
        });

        res.json(places);

    } catch (err) {
        console.error("❌ /places error:", err);
        res.status(500).json([]);
    }
});

/**
 * Directions endpoint
 *
 * Example:
 * /directions?originLat=33.749&originLng=-84.388&destLat=33.755&destLng=-84.39
 */
app.get("/directions", async (req, res) => {
    try {
        const originLat = Number(req.query.originLat);
        const originLng = Number(req.query.originLng);
        const destLat = Number(req.query.destLat);
        const destLng = Number(req.query.destLng);

        if (
            !originLat || !originLng ||
            !destLat || !destLng
        ) {
            return res.status(400).json({
                error: "Missing required query parameters"
            });
        }

        const result = await getDirectionsDistance({
            originLat,
            originLng,
            destLat,
            destLng
        });

        res.json(result);

    } catch (err) {
        console.error("❌ /directions error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Add this temporary endpoint for cache clearing - REMOVE AFTER TESTING
app.get("/clear-cache", async (req, res) => {
    try {
        await redis.flushAll();
        res.json({ success: true, message: "All cache cleared" });
    } catch (err) {
        console.error("❌ Cache clear error:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Start server (Render-compatible)
 */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
