import express from "express";
import "./redis.js";
import { getNearbyPlaces } from "./places.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.post("/places/nearby", async (req, res) => {
    try {
        const { lat, lng, radius, type } = req.body;

        if (!lat || !lng || !radius || !type) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        const places = await getNearbyPlaces({ lat, lng, radius, type });
        res.json(places);
    } catch (err) {
        console.error(err.response?.data || err);
        res.status(500).json({ error: "Failed to fetch places" });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
