import { generateSW } from "workbox-build";

const { count, size, warnings } = await generateSW({
  globDirectory: "dist",
  globPatterns: ["**/*.{css,html,js,webmanifest}"],
  swDest: "dist/service-worker.js",
  clientsClaim: true,
  skipWaiting: true,
  runtimeCaching: [
    {
      urlPattern: /\/api\/submissions$/,
      method: "POST",
      handler: "NetworkOnly",
      options: {
        backgroundSync: {
          name: "offline-submissions",
          options: {
            maxRetentionTime: 24 * 60,
          },
        },
      },
    },
  ],
});

for (const warning of warnings) {
  console.warn(warning);
}

console.log(
  `Generated Workbox service worker for ${count} files (${size} bytes).`,
);
