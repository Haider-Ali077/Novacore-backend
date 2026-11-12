import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@abaplint/core", "jszip", "pdfmake", "pdfjs-dist"],
  // The app sits inside the ABAPGIT_ALV repo; pin the root so a stray lockfile there is never picked up.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // Read with fs at runtime (agent prompts, DOCX template and logo, DDIC catalog, model prices), so Vercel must bundle them.
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*", "./templates/**/*", "./catalog/**/*", "./config/**/*", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};
export default nextConfig;
