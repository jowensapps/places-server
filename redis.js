import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    console.error("❌ REDIS_URL is not set");
    process.exit(1);
}

export const redis = createClient({
    url: redisUrl
});

redis.on("connect", () => {
    console.log("🔗 Redis connecting...");
});

redis.on("ready", () => {
    console.log("✅ Connected to Redis");
});

redis.on("error", (err) => {
    console.error("Redis Client Error", err);
});

await redis.connect();
