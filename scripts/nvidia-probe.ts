import nextEnv from "@next/env";
import OpenAI from "openai";
import { probeNvidiaModel } from "../src/server/agents/nvidia-probe";
import { HttpError } from "../src/server/http";
nextEnv.loadEnvConfig(process.cwd());
try {
  console.log(await probeNvidiaModel());
} catch (error) {
  console.error(
    error instanceof HttpError
      ? error.message
      : error instanceof OpenAI.APIConnectionError
        ? "NVIDIA connection failed before an HTTP response. Check system certificate trust and network access; no automatic retry was made."
        : error instanceof OpenAI.APIError
          ? `NVIDIA probe failed with HTTP ${error.status ?? "unknown"}. Check API key access, quota and supported request options; no automatic retry was made.`
          : "NVIDIA probe failed validation or connection. Check endpoint access, TLS and the model response contract. Credentials were not logged.",
  );
  process.exitCode = 1;
}
