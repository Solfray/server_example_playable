import { defineConfig } from "vitest/config";

// Pure-function tests run on Node: WebCrypto (Ed25519, HMAC, RSA) is the same
// API the Worker uses, so src/auth/* and src/api/maps.ts are testable without
// a Workers runtime.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
