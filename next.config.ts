import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: [
    "pdfjs-dist",
    "tesseract.js",
    "@tesseract.js-data/eng",
    "@napi-rs/canvas",
  ],
};

export default config;
