import { Router } from "express";

const router = Router();

const DEBUG_TOKEN = "debug-db-data-download";

let storedPayload = null;

function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== DEBUG_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// iPhone uploads trips
router.post("/debug/sync", authCheck, (req, res) => {
  const { device, trips } = req.body;

  if (!trips || !Array.isArray(trips)) {
    return res.status(400).json({ error: "Missing or invalid trips array" });
  }

  storedPayload = {
    device: device || "unknown",
    uploadedAt: new Date().toISOString(),
    trips: trips,
  };

  console.log(`[debug-sync] Received ${trips.length} trips from ${device}`);
  res.json({ success: true, count: trips.length });
});

// Android downloads trips
router.get("/debug/sync", authCheck, (req, res) => {
  if (!storedPayload) {
    return res.status(404).json({ error: "No trips uploaded yet" });
  }
  res.json(storedPayload);
});

// Clear stored data
router.delete("/debug/sync", authCheck, (req, res) => {
  storedPayload = null;
  res.json({ success: true, message: "Cleared" });
});

export default router;
