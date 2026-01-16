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
 * Health check
 */
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

/**
 * Places Nearby endpoint
 * Example:
 * /places?lat=33.749&lng=-84.388&radius=500&type=restaurant
 */
app.get("/places", async (req, res) => {
    try {
        const { lat, lng, radius, type } = req.query;

        if (!lat || !lng || !radius || !type) {
            return res.status(400).json({
                error: "Missing required query parameters"
            });
        }

        const places = await getNearbyPlaces({
            lat: Number(lat),
            lng: Number(lng),
            radius: Number(radius),
            type
        });

        res.json(places);

    } catch (err) {
        console.error("❌ /places error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * Directions endpoint
 * Example:
 * /directions?originLat=33.749&originLng=-84.388&destLat=33.755&destLng=-84.39
 */
app.get("/directions", async (req, res) => {
    try {
        const {
            originLat,
            originLng,
            destLat,
            destLng
        } = req.query;

        if (
            !originLat || !originLng ||
            !destLat || !destLng
        ) {
            return res.status(400).json({
                error: "Missing required query parameters"
            });
        }

        const result = await getDirectionsDistance({
            originLat: Number(originLat),
            originLng: Number(originLng),
            destLat: Number(destLat),
            destLng: Number(destLng)
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
