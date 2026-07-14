import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/life-tracker-pwa/",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["life-tracker-logo-v112.png", "apple-touch-icon-v112.png", "pwa-192x192-v112.png", "pwa-512x512-v112.png"],
      manifest: {
        name: "Life Tracker",
        short_name: "Life Tracker",
        description: "记录你的旅行、消费与日常瞬间",
        theme_color: "#0A84FF",
        background_color: "#F5F5F7",
        display: "standalone",
        start_url: "/life-tracker-pwa/",
        scope: "/life-tracker-pwa/",
        lang: "zh-CN",
        icons: [
          { src: "pwa-192x192-v112.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512-v112.png", sizes: "512x512", type: "image/png", purpose: "any" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,woff2}"],
        globIgnores: ["**/og.png"],
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.frankfurter\.dev\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "exchange-rates",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 30, maxAgeSeconds: 7 * 24 * 60 * 60 }
            }
          }
        ]
      }
    })
  ]
});
