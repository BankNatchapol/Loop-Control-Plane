import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: process.env.LOOPBOARD_DATABASE_PATH ?? "./data/loopboard.sqlite",
  },
  strict: true,
  verbose: true,
});
