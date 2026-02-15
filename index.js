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
**/
app.get("/places", async (req, res) => {
    try {
        const { lat, lng, radius, groceryMode } = req.query;  // ADD groceryMode

        if (!lat || !lng) {
            return res.status(400).json({ error: "Missing lat/lng" });
        }

        const r = radius ? parseInt(radius, 10) : 200;

        const places = await getNearbyPlaces({
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            radius: r,
            groceryMode: groceryMode  // PASS IT THROUGH
        });

        res.json(places);
    } catch (err) {
        console.error("❌ Places endpoint error:", err);
        res.status(500).json({ error: err.message });
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

/**
 * Start server (Render-compatible)
 */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
