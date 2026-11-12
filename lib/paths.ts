// Folders the app writes to. On Vercel the deployment bundle is read-only and only /tmp is
// writable; /tmp is wiped whenever the function restarts, so data kept there is demo-only.
import path from "node:path";

const writable = (local: string, vercel: string) => (process.env.VERCEL ? vercel : path.join(process.cwd(), local));

export const DATA_DIR = writable("data", "/tmp/supernova-data");
export const OUTPUT_DIR = writable("output", "/tmp/supernova-output");
