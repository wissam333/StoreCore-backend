import { randomBytes } from "crypto";

const key = [
  randomBytes(4).toString("hex").toUpperCase(),
  randomBytes(4).toString("hex").toUpperCase(),
  randomBytes(4).toString("hex").toUpperCase(),
  randomBytes(4).toString("hex").toUpperCase(),
].join("-");

console.log("License key:", key);
// Example: A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6

// Step 2 — Insert it into your Postgres DB on Render:
// INSERT INTO licenses (key, buyer_name, notes)
// VALUES ('XXXX-XXXX-XXXX-XXXX', 'Customer Name', 'Purchased April 2026');