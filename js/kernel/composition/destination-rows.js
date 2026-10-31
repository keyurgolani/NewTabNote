/**
 * The destination registry's rows, written from security/destinations.json by `npm run check:destinations -- --write`.
 * Edit the registry, not this file: `npm run check:destinations` fails when they differ, and
 * js/kernel/composition/destinations.js checks the rows as it loads.
 */

/**
 * `value`, frozen with everything in it
 * @template T
 * @param {T} value
 * @returns {T}
 */
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** @type {readonly unknown[]} */
export const DESTINATION_ROWS = freeze([
  {
    "id": "openai",
    "kind": "packaged",
    "origin": "https://api.openai.com",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "anthropic",
    "kind": "packaged",
    "origin": "https://api.anthropic.com",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "x-api-key",
    "headers": [
      "anthropic-dangerous-direct-browser-access",
      "anthropic-version",
      "Content-Type",
      "x-api-key"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "gemini",
    "kind": "packaged",
    "origin": "https://generativelanguage.googleapis.com",
    "pathPrefix": "/v1beta/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "x-goog-api-key",
    "headers": [
      "Content-Type",
      "x-goog-api-key"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "openrouter",
    "kind": "packaged",
    "origin": "https://openrouter.ai",
    "pathPrefix": "/api/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type",
      "HTTP-Referer",
      "X-Title"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "xai",
    "kind": "packaged",
    "origin": "https://api.x.ai",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "deepseek",
    "kind": "packaged",
    "origin": "https://api.deepseek.com",
    "pathPrefix": "/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "mistral",
    "kind": "packaged",
    "origin": "https://api.mistral.ai",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "groq",
    "kind": "packaged",
    "origin": "https://api.groq.com",
    "pathPrefix": "/openai/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "qwen-intl",
    "kind": "packaged",
    "origin": "https://dashscope-intl.aliyuncs.com",
    "pathPrefix": "/compatible-mode/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "qwen-china",
    "kind": "packaged",
    "origin": "https://dashscope.aliyuncs.com",
    "pathPrefix": "/compatible-mode/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "glm-general",
    "kind": "packaged",
    "origin": "https://api.z.ai",
    "pathPrefix": "/api/paas/v4/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": true,
    "owner": 11
  },
  {
    "id": "glm-coding",
    "kind": "packaged",
    "origin": "https://api.z.ai",
    "pathPrefix": "/api/coding/paas/v4/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": true,
    "owner": 11
  },
  {
    "id": "glm-china",
    "kind": "packaged",
    "origin": "https://open.bigmodel.cn",
    "pathPrefix": "/api/paas/v4/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": true,
    "owner": 11
  },
  {
    "id": "kimi-intl",
    "kind": "packaged",
    "origin": "https://api.moonshot.ai",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "kimi-china",
    "kind": "packaged",
    "origin": "https://api.moonshot.cn",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "minimax-intl",
    "kind": "packaged",
    "origin": "https://api.minimax.io",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "minimax-china",
    "kind": "packaged",
    "origin": "https://api.minimax.chat",
    "pathPrefix": "/v1/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "bearer",
    "headers": [
      "Authorization",
      "Content-Type"
    ],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 11
  },
  {
    "id": "ollama-localhost",
    "kind": "legacy",
    "origin": "http://localhost:*",
    "pathPrefix": "/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "none",
    "headers": [
      "Content-Type"
    ],
    "location": "loopback",
    "reachedBy": "fetch",
    "proxy": true,
    "owner": 9,
    "removeWhen": 9,
    "note": "Only the stored ollamaUrl's own port: the client takes it as the one loopback origin allowed"
  },
  {
    "id": "ollama-127",
    "kind": "legacy",
    "origin": "http://127.0.0.1:*",
    "pathPrefix": "/",
    "methods": [
      "GET",
      "POST"
    ],
    "credential": "none",
    "headers": [
      "Content-Type"
    ],
    "location": "loopback",
    "reachedBy": "fetch",
    "proxy": true,
    "owner": 9,
    "removeWhen": 9,
    "note": "Only the stored ollamaUrl's own port: the client takes it as the one loopback origin allowed"
  },
  {
    "id": "embedding-model",
    "kind": "legacy",
    "origin": "https://huggingface.co",
    "pathPrefix": "/",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 9,
    "removeWhen": 9,
    "egress": "embedding-model"
  },
  {
    "id": "embedding-model-hub",
    "kind": "legacy",
    "origin": "https://*.huggingface.co",
    "pathPrefix": "/",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 9,
    "removeWhen": 9,
    "egress": "embedding-model"
  },
  {
    "id": "embedding-model-cdn",
    "kind": "legacy",
    "origin": "https://*.hf.co",
    "pathPrefix": "/",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 9,
    "removeWhen": 9,
    "egress": "embedding-model"
  },
  {
    "id": "model-runtime",
    "kind": "legacy",
    "origin": "https://cdn.jsdelivr.net",
    "pathPrefix": "/",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "fetch",
    "proxy": false,
    "owner": 9,
    "removeWhen": 9,
    "egress": "model-runtime"
  },
  {
    "id": "favicons",
    "kind": "packaged",
    "origin": "https://www.google.com",
    "pathPrefix": "/s2/favicons",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "image",
    "proxy": false,
    "owner": 21,
    "egress": "favicons"
  },
  {
    "id": "video-youtube",
    "kind": "packaged",
    "origin": "https://www.youtube.com",
    "pathPrefix": "/embed/",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "frame",
    "proxy": false,
    "owner": 21,
    "egress": "video-embeds"
  },
  {
    "id": "video-vimeo",
    "kind": "packaged",
    "origin": "https://player.vimeo.com",
    "pathPrefix": "/video/",
    "methods": [
      "GET"
    ],
    "credential": "none",
    "headers": [],
    "location": "remote",
    "reachedBy": "frame",
    "proxy": false,
    "owner": 21,
    "egress": "video-embeds"
  }
]);
