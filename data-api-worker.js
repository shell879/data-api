// ──────────────────────────────────────────────────────────────
// ShellDesignz Data API Worker
// ──────────────────────────────────────────────────────────────
//
// This Worker serves all API routes for shelldesignz.com.
// It handles:
//
//   • /api/scan        — Image → text extraction via vision AI
//   • /api/identify    — Food photo → identified recipe via vision + text AI
//   • /api/join-store  — Add a shared store to a user's account
//   • /api/switch-store — Change the user's active store
//   • /api/my-stores   — List all stores a user has access to
//   • /api/christmas   — GET/POST per-user recipe data shared by the
//                        Christmas and MyNutrition pages (scoped by store)
//   • /api/data        — GET/POST shared app data (global, not per-user)
//
// Data is stored in Workers KV (env.DATA), keyed as:
//   • user:<email>           → user record (stores list, active store)
//   • store:<storeId>:christmasData → recipe data for that store
//   • appData                → shared global app data
//
// User identity comes from Cloudflare Access. The Worker reads the
// logged-in user's email via ctx.access.getIdentity(), with fallbacks
// to the CF_Authorization cookie and the Cf-Access-Jwt-Assertion header.
//
// AI requests (scan, identify) are routed through the AI Gateway
// (id: "default") for caching, analytics, and per-user spend limits.
//
// ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ───────────────────────────────────────
    // Browsers send an OPTIONS request before cross-origin POST/GET
    // requests. We respond with the allowed headers so the browser
    // proceeds with the actual request. This is needed for local
    // development where the frontend and API may be on different ports.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // ── Route: Image scan ───────────────────────────────────
    // POST /api/scan
    // Accepts a multipart/form-data upload with a "file" field (image).
    // Sends the image to the vision model to extract all visible text.
    // Returns a structured recipe object with name + ingredients.
    // Routed through AI Gateway for caching and spend tracking.
    if (url.pathname === "/api/scan" && request.method === "POST") {
      return handleScan(request, env, ctx);
    }

    // ── Route: Food identification ───────────────────────────
    // POST /api/identify
    // Accepts a multipart/form-data upload with a "file" field (food photo).
    // Step 1: Vision model identifies the food in 1-3 words.
    // Step 2: Text LLM generates a full recipe (ingredients + instructions).
    // Returns a structured recipe object.
    // Routed through AI Gateway for caching and spend tracking.
    if (url.pathname === "/api/identify" && request.method === "POST") {
      return handleIdentify(request, env, ctx);
    }

    // ── Route: Join a shared store ───────────────────────────
    // POST /api/join-store
    // Body: { storeId: <number> }
    // Adds the given storeId to the logged-in user's store list
    // and sets it as their active store. Used when sharing a store
    // with another user (e.g., via a join link).
    if (url.pathname === "/api/join-store" && request.method === "POST") {
      return handleJoinStore(request, env, ctx);
    }

    // ── Route: Switch active store ──────────────────────────
    // POST /api/switch-store
    // Body: { storeId: <number> }
    // Changes the user's active store. All subsequent /api/christmas
    // requests will read/write data for this store.
    // Response includes no-cache headers so the browser never serves
    // a stale store selection.
    if (url.pathname === "/api/switch-store" && request.method === "POST") {
      return handleSwitchStore(request, env, ctx);
    }

    // ── Route: List user's stores ────────────────────────────
    // GET /api/my-stores
    // Returns all stores the logged-in user has access to, with
    // each store's name (pulled from the store's christmasData).
    // Response includes no-cache headers so the store list is
    // always fresh.
    if (url.pathname === "/api/my-stores" && request.method === "GET") {
      return handleMyStores(request, env, ctx);
    }

    // ── Route: Data storage (store recipes + shared catalog) ─
    // GET/POST /api/christmas → per-user store recipes used by both the
    // Christmas and MyNutrition pages. These are two views of the same data,
    // not separate KV datasets.
    // GET/POST /api/data      → shared global app data
    //
    // For /api/christmas, we look up the user's active store and
    // use "store:<storeId>:christmasData". The URL name is historical;
    // the key is shared by both page experiences and isolated by store.
    //
    // For everything else (e.g., /api/data), we use the shared
    // "appData" key — this is global data not tied to a specific user.
    //
    // POST saves the request body to KV.
    // GET reads from KV and returns the JSON data.
    // GET responses include Cache-Control: no-cache so the browser
    // always revalidates with the origin before serving.
    let key;
    if (url.pathname === "/api/christmas") {
      const storeId = await getUserStore(env, ctx, request);
      key = `store:${storeId}:christmasData`;
    } else {
      key = "appData";
    }

    // POST — write data to KV
    if (request.method === "POST") {
      const body = await request.text();
      await env.DATA.put(key, body);
      return new Response(JSON.stringify({ success: true, bytes: body.length }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // GET — read data from KV
    const data = await env.DATA.get(key);
    if (!data) {
      return new Response(JSON.stringify({ error: "No data found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(data, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

// ──────────────────────────────────────────────────────────────
// Helper: Get the user's active store ID
// ──────────────────────────────────────────────────────────────
// Identifies the user by email (via Access), then looks up their
// user record in KV. Returns the activeStore ID.
//
// If the user doesn't have a record yet (first visit), creates one
// with a new store ID and seeds it with empty recipe data so the
// app doesn't get a 404 on first load.
//
// Also handles migration from the old data format (single storeId
// field) to the new format (stores array + activeStore).
async function getUserStore(env, ctx, request) {
  let email = "guest";

  // ── Try ctx.access (Cloudflare Access binding) ───────────
  // This is the preferred method. When Access is enabled on the
  // Worker, ctx.access.getIdentity() returns the authenticated
  // user's identity object including their email.
  if (ctx.access) {
    try {
      const identity = await ctx.access.getIdentity();
      email = identity.email;
    } catch {}
  }

  // ── Fallback: CF_Authorization cookie ────────────────────
  // If ctx.access isn't available (e.g., Access isn't enabled on
  // the Worker route), we can decode the Access JWT from the
  // CF_Authorization cookie that Access sets in the browser.
  // The JWT payload (middle segment, base64-decoded) contains
  // the user's email.
  if (email === "guest") {
    const cookie = request.headers.get("Cookie") || "";
    const cfAuth = cookie.match(/CF_Authorization=([^;]+)/);
    if (cfAuth) {
      try {
        const payload = JSON.parse(atob(cfAuth[1].split(".")[1]));
        email = payload.email || email;
      } catch {}
    }
  }

  // ── Fallback: Cf-Access-Jwt-Assertion header ─────────────
  // Access also sends the JWT in a request header. Same decoding
  // approach as the cookie fallback.
  if (email === "guest") {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (jwt) {
      try {
        const payload = JSON.parse(atob(jwt.split(".")[1]));
        email = payload.email || email;
      } catch {}
    }
  }

  // ── Look up or create the user record in KV ──────────────
  // Key format: "user:<email>"
  // Value: { stores: [storeId, ...], activeStore: storeId, email, created }
  const userKey = `user:${email}`;
  let userRecord = await env.DATA.get(userKey);

  // First-time user: create a new record with one store
  if (!userRecord) {
    const storeId = Date.now();
    userRecord = JSON.stringify({
      stores: [storeId],
      activeStore: storeId,
      email,
      created: new Date().toISOString(),
    });
    await env.DATA.put(userKey, userRecord);

    // Seed the new store with empty recipe data so the app
    // has a starting point instead of a 404
    const emptyData = JSON.stringify({
      stores: [{ id: 1, name: 'My Recipes', active: true, flavorProfiles: [] }],
      categories: [],
      drinkRecipes: [],
    });
    await env.DATA.put(`store:${storeId}:christmasData`, emptyData);
  }

  const user = JSON.parse(userRecord);

  // ── Migrate old format ──────────────────────────────────
  // Older user records used a single "storeId" field instead of
  // the "stores" array. If we find the old format, migrate it
  // to the new format and save.
  if (!user.stores && user.storeId) {
    user.stores = [user.storeId];
    user.activeStore = user.storeId;
    await env.DATA.put(userKey, JSON.stringify(user));
  }

  // Return the active store ID (or the first store if no active set)
  return user.activeStore || user.stores[0];
}

// ──────────────────────────────────────────────────────────────
// Handler: Join a shared store
// ──────────────────────────────────────────────────────────────
// POST /api/join-store
// Body: { storeId: <number> }
//
// Adds the given storeId to the user's stores list and makes it
// the active store. If the user already has this store, just
// switches to it. The user must already exist in KV (created on
// first visit via getUserStore).
async function handleJoinStore(request, env, ctx) {
  try {
    const body = await request.json();
    const storeId = Number(body.storeId);
    if (!storeId) {
      return Response.json(
        { error: "storeId required" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const email = await getEmail(env, ctx, request);
    const userKey = `user:${email}`;
    let userRecord = await env.DATA.get(userKey);

    if (!userRecord) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const user = JSON.parse(userRecord);

    // Migrate old format if needed (single storeId → stores array)
    if (!user.stores && user.storeId) {
      user.stores = [user.storeId];
      user.activeStore = user.storeId;
    }

    // Add the store if the user doesn't already have it
    if (!user.stores.includes(storeId)) {
      user.stores.push(storeId);
    }
    user.activeStore = storeId;

    await env.DATA.put(userKey, JSON.stringify(user));

    return Response.json(
      { success: true, stores: user.stores, activeStore: user.activeStore },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  } catch (err) {
    return Response.json(
      { error: "Join failed", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}

// ──────────────────────────────────────────────────────────────
// Handler: Switch active store
// ──────────────────────────────────────────────────────────────
// POST /api/switch-store
// Body: { storeId: <number> }
//
// Changes the user's active store. The user must already have
// access to the store (it must be in their stores list). If they
// don't, returns 403.
//
// Response includes no-cache, no-store, must-revalidate so the
// browser never serves a stale store selection from cache —
// this is critical for the PWA to always show the correct store.
async function handleSwitchStore(request, env, ctx) {
  try {
    const body = await request.json();
    const storeId = Number(body.storeId);
    if (!storeId) {
      return Response.json(
        { error: "storeId required" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const email = await getEmail(env, ctx, request);
    const userKey = `user:${email}`;
    let userRecord = await env.DATA.get(userKey);

    if (!userRecord) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const user = JSON.parse(userRecord);

    // Migrate old format if needed
    if (!user.stores && user.storeId) {
      user.stores = [user.storeId];
      user.activeStore = user.storeId;
    }

    // Security check: user must already have access to this store
    if (!user.stores.includes(storeId)) {
      return Response.json(
        { error: "You don't have access to this store" },
        { status: 403, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    user.activeStore = storeId;
    await env.DATA.put(userKey, JSON.stringify(user));

    return Response.json(
      { success: true, activeStore: storeId },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (err) {
    return Response.json(
      { error: "Switch failed", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}

// ──────────────────────────────────────────────────────────────
// Handler: List user's stores with names
// ──────────────────────────────────────────────────────────────
// GET /api/my-stores
//
// Returns all stores the user has access to, including the store
// name (pulled from each store's christmasData). The frontend uses
// this to render the store picker dropdown. Each user starts with
// their own store at index 0; joining a store appends it to the list.
//
// Response includes no-cache, no-store, must-revalidate so the
// store list is always fresh — if a user joins a new store, it
// shows up immediately on the next request.
async function handleMyStores(request, env, ctx) {
  try {
    const email = await getEmail(env, ctx, request);
    const userKey = `user:${email}`;
    let userRecord = await env.DATA.get(userKey);

    // No user record yet → return empty store list
    if (!userRecord) {
      return Response.json(
        { stores: [] },
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        }
      );
    }

    const user = JSON.parse(userRecord);

    // Migrate old format if needed
    if (!user.stores) {
      user.stores = [user.storeId];
      user.activeStore = user.storeId;
    }

    // Fetch each store's name from its christmasData in KV.
    // We use Promise.all to fetch all stores in parallel for speed.
    const stores = await Promise.all(
      user.stores.map(async (storeId, index) => {
        const data = await env.DATA.get(`store:${storeId}:christmasData`);
        let name = `Store ${storeId}`;
        if (data) {
          try {
            const parsed = JSON.parse(data);
            name = parsed.stores?.[0]?.name || name;
          } catch {}
        }
        return {
          storeId,
          name,
          active: storeId === user.activeStore,
          owned: index === 0,
        };
      })
    );

    return Response.json(
      { stores },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  } catch (err) {
    return Response.json(
      { error: "Failed to list stores", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}

// ──────────────────────────────────────────────────────────────
// Helper: Get the logged-in user's email from Cloudflare Access
// ──────────────────────────────────────────────────────────────
// Tries three methods in order, falling back to "guest" if none work:
//
//   1. ctx.access.getIdentity() — preferred, works when Access is
//      enabled on the Worker
//   2. CF_Authorization cookie — Access sets this in the browser;
//      we decode the JWT payload to extract the email
//   3. Cf-Access-Jwt-Assertion header — Access sends this on
//      proxied requests; same JWT decoding approach
//
// The try/catch blocks ensure that if one method fails (e.g., the
// JWT is malformed or ctx.access isn't available), we silently
// fall back to the next method instead of crashing the request.
//
// If all three fail, email stays "guest" — the user gets a
// temporary guest store rather than being locked out.
async function getEmail(env, ctx, request) {
  let email = "guest";

  // ── Method 1: ctx.access binding ─────────────────────────
  if (ctx.access) {
    try {
      const identity = await ctx.access.getIdentity();
      email = identity.email;
    } catch {}
  }

  // ── Method 2: CF_Authorization cookie ────────────────────
  if (email === "guest") {
    const cookie = request.headers.get("Cookie") || "";
    const cfAuth = cookie.match(/CF_Authorization=([^;]+)/);
    if (cfAuth) {
      try {
        // JWT format: header.payload.signature
        // We decode the payload (middle segment) from base64
        const payload = JSON.parse(atob(cfAuth[1].split(".")[1]));
        email = payload.email || email;
      } catch {}
    }
  }

  // ── Method 3: Cf-Access-Jwt-Assertion header ──────────────
  if (email === "guest") {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (jwt) {
      try {
        const payload = JSON.parse(atob(jwt.split(".")[1]));
        email = payload.email || email;
      } catch {}
    }
  }

  return email;
}

// ──────────────────────────────────────────────────────────────
// Handler: Image scan — extract text from an image
// ──────────────────────────────────────────────────────────────
// POST /api/scan
// Input:  multipart/form-data with field "file" (an image)
// Output: JSON recipe object { id, storeId, name, categoryId, ingredients[] }
//
// Flow:
//   1. Get the uploaded image file from form data
//   2. Convert it to a base64 data URI (required by the vision model)
//   3. Send to llama-3.2-11b-vision-instruct with a system prompt
//      asking it to extract ALL visible text, line by line
//   4. Parse the model's response:
//      - First try: look for JSON in the response
//      - Fallback: treat each line as text (first line = name, rest = ingredients)
//   5. Return a structured recipe object
//
// The AI call is routed through the AI Gateway (id: "default") with:
//   • Caching enabled (cacheTtl: 3600 = 1 hour) — identical image+prompt
//     returns cached result without consuming neurons
//   • User ID metadata — tags the request with the user's email for
//     per-user spend limit tracking
async function handleScan(request, env, ctx) {
  try {
    // ── Get the uploaded file ──────────────────────────────
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json(
        { error: "No file uploaded. Use field name 'file'." },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    // ── Identify the user for spend tracking ───────────────
    const email = await getEmail(env, ctx, request);

    if (!email) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    // ── Convert image to base64 data URI ───────────────────
    // The vision model accepts images as data URIs:
    //   data:<mime-type>;base64,<base64-encoded-bytes>
    //
    // We process in 8KB chunks to avoid call stack limits when
    // converting large images with String.fromCharCode.
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const mimeType = file.type || "image/jpeg";
    const dataUri = `data:${mimeType};base64,${base64}`;

    // ── Call the vision model ──────────────────────────────
    // System prompt instructs the model to extract ALL visible text
    // from the image, one line per line, with no commentary.
    // The model returns raw text that we parse below.
    //
    // Gateway options (third argument):
    //   id: "default"     → route through the AI Gateway
    //   skipCache: false  → enable caching
    //   cacheTtl: 3600     → cache for 1 hour (saves neurons on repeats)
    //   metadata.user_id  → tag with user's email for spend limits
    const systemPrompt = [
      "Extract ALL visible text from this image.",
      "Output each line of text exactly as it appears, one per line.",
      "Do not add descriptions, commentary, or formatting — just the raw text lines.",
    ].join("\n");

    const response = await env.AI.run(
      "@cf/meta/llama-3.2-11b-vision-instruct",
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "List every line of text you can read in this image." },
        ],
        image: dataUri,
        max_tokens: 2048,
      },
      {
        gateway: {
          id: "default",
          skipCache: false,
          cacheTtl: 3600,
          metadata: { user_id: email },
        },
      }
    );

    // ── Parse the model's response ─────────────────────────
    // The model returns text in response.response (or response.result
    // as fallback). We try to extract structured JSON first, then
    // fall back to line-by-line text parsing.
    const raw = response.response || response.result || "";

    let extracted;

    // Try 1: Look for a JSON object in the response text
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        extracted = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      } catch {}
    }

    // Try 2: Parse as plain text lines
    // Filter out common model preamble lines ("Here is...", "I can see...")
    // and formatting characters (*, -, •, #).
    // First surviving line = recipe name, rest = ingredients.
    if (!extracted) {
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        // Remove model preamble ("Here is the text...", "I can see...")
        .filter((l) => l && !/^(here is|the image|this (image|picture|photo)|i (can|would|see)|to extract)/i.test(l))
        // Remove lines that are only formatting characters
        .filter((l) => !/^[\*\-•#]+$/.test(l))
        // Strip leading bullet points and markdown headers
        .map((l) => l.replace(/^[\*\-•\u2022]\s*/, "").replace(/^#+\s*/, "").trim())
        .filter((l) => l.length > 1);

      if (lines.length === 0) {
        return Response.json(
          { error: "Could not parse model output", raw },
          { status: 502, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }

      // First line = recipe name, remaining lines = ingredients
      // Skip lines that look like section headers ("Ingredients:", "Equipment:")
      const name = lines[0];
      const ingredients = lines
        .slice(1)
        .filter((l) => !/^(ingredients?|equipment|instructions?|directions?|method):?\s*$/i.test(l))
        .map((l) => ({ name: l, side: "TOP" }));

      extracted = { name, ingredients };
    }

    // ── Build the recipe object ────────────────────────────
    // Standard structure used by the frontend to render recipes.
    // Each ingredient gets: id, name, cost (default 0), side (TOP/BOTTOM),
    // and displayOrder for sorting.
    const recipe = {
      id: Date.now(),
      storeId: null,
      name: extracted.name || "Unknown",
      categoryId: null,
      ingredients: (extracted.ingredients || []).map((ing, index) => ({
        id: index + 1,
        name: ing.name,
        cost: 0,
        side: ing.side || "TOP",
        displayOrder: index + 1,
      })),
    };

    return Response.json(recipe, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return Response.json(
      { error: "Scan failed", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}

// ──────────────────────────────────────────────────────────────
// Handler: Food identification — photo → recipe
// ──────────────────────────────────────────────────────────────
// POST /api/identify
// Input:  multipart/form-data with field "file" (a food photo)
// Output: JSON recipe object { id, storeId, name, identified, categoryId, ingredients[] }
//
// This is a two-step AI pipeline:
//
//   Step 1 — Vision model (llama-3.2-11b-vision-instruct):
//     Looks at the photo and identifies the food in 1-3 words.
//     Example: "orange cake", "chocolate chip cookies", "pepperoni pizza"
//
//   Step 2 — Text LLM (llama-3.1-8b-instruct-fast):
//     Takes the food name from step 1 and generates a full recipe
//     with INGREDIENTS and INSTRUCTIONS sections.
//
// Both AI calls are routed through the AI Gateway with caching
// (1 hour TTL) and user_id metadata for spend tracking.
//
// The response combines ingredients (side: "TOP") and instructions
// (side: "BOTTOM") into a single ingredients array, since the
// frontend treats both as line items in the recipe.
async function handleIdentify(request, env, ctx) {
  try {
    // ── Get the uploaded file ──────────────────────────────
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json(
        { error: "No file uploaded. Use field name 'file'." },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    // ── Identify the user for spend tracking ───────────────
    const email = await getEmail(env, ctx, request);

    if (!email) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    // ── Convert image to base64 data URI ───────────────────
    // Same chunked approach as handleScan — processes in 8KB
    // chunks to avoid stack overflow on large images.
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const mimeType = file.type || "image/jpeg";
    const dataUri = `data:${mimeType};base64,${base64}`;

    // ── Step 1: Vision model identifies the food ────────────
    // We ask for a concise 1-3 word identification so the text
    // model in step 2 has a clean food name to work with.
    // Caching is enabled — if another user uploads the same
    // food photo, this step returns from cache (no neurons used).
    const visionResult = await env.AI.run(
      "@cf/meta/llama-3.2-11b-vision-instruct",
      {
        messages: [
          {
            role: "system",
            content:
              "Identify the food in this image in 1-3 words. Include flavor and key toppings if visible. Examples: 'orange cake', 'chocolate chip cookies', 'pepperoni pizza'. Reply with only the food name, nothing else.",
          },
          { role: "user", content: "What food is in this image?" },
        ],
        image: dataUri,
        max_tokens: 256,
      },
      {
        gateway: {
          id: "default",
          skipCache: false,
          cacheTtl: 3600,
          metadata: { user_id: email },
        },
      }
    );

    // Extract the food name from the vision model's response
    const foodDescription = visionResult.response || visionResult.result || "unknown food";

    // ── Step 2: Text LLM generates the recipe ───────────────
    // Given the food name from step 1, the text model writes a
    // full recipe with two labeled sections:
    //   INGREDIENTS — each ingredient on its own line
    //   INSTRUCTIONS — each step on its own line
    //
    // We use llama-3.1-8b-instruct-fast (a smaller, faster model)
    // for this step since it's a text-only task — no vision needed.
    const recipeResult = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      {
        messages: [
          {
            role: "system",
            content:
              "You are a recipe generator. Given a food description, write a complete recipe. Output two sections labeled exactly INGREDIENTS and INSTRUCTIONS. Under INGREDIENTS, list each ingredient on its own line. Under INSTRUCTIONS, list each step on its own line. Do not include anything else — no author, no source, no commentary, no sub-recipes.",
          },
          { role: "user", content: `Write a recipe for: ${foodDescription}` },
        ],
        max_tokens: 2048,
      },
      {
        gateway: {
          id: "default",
          skipCache: false,
          cacheTtl: 3600,
          metadata: { user_id: email },
        },
      }
    );

    // ── Parse the recipe text ──────────────────────────────
    // The model outputs plain text with INGREDIENTS and INSTRUCTIONS
    // section headers. We split the text at those headers and parse
    // each section into individual lines.
    //
    // Ingredients → side: "TOP" (displayed on the top half of the recipe card)
    // Instructions → side: "BOTTOM" (displayed on the bottom half)
    const raw = recipeResult.response || recipeResult.result || "";

    // Find the section headers (case-insensitive)
    const upperRaw = raw.toUpperCase();
    const ingStart = upperRaw.indexOf("INGREDIENTS");
    const instrStart = upperRaw.indexOf("INSTRUCTIONS");

    let ingredients = [];
    let instructions = [];

    if (ingStart !== -1 && instrStart !== -1 && ingStart < instrStart) {
      // ── Normal case: both headers found ──────────────────
      // Extract text between INGREDIENTS and INSTRUCTIONS,
      // then text after INSTRUCTIONS.
      const ingText = raw.slice(ingStart + 12, instrStart).trim();
      const instrText = raw.slice(instrStart + 13).trim();

      // Parse ingredients: split by line, clean up formatting
      ingredients = ingText
        .split("\n")
        .map((l) => l.trim())
        // Skip the "Ingredients:" header itself
        .filter((l) => l && !/^ingredients?\s*:?\s*$/i.test(l))
        // Strip bullet points and numbered list markers
        .map((l) => l.replace(/^[\*\-•\u2022]\s*/, "").replace(/^\d+\.\s*/, "").trim())
        .filter((l) => l.length > 1);

      // Parse instructions: same approach, but keep step numbers off
      instructions = instrText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^instructions?\s*:?\s*$/i.test(l))
        .map((l) => l.replace(/^[\*\-•\u2022]\s*/, "").trim())
        .filter((l) => l.length > 1);
    } else {
      // ── Fallback: no section headers found ───────────────
      // Treat all lines as ingredients. This handles cases where
      // the model didn't follow the format instructions.
      const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 1);
      ingredients = lines;
    }

    // ── Build the recipe object ────────────────────────────
    // Combine ingredients (TOP) and instructions (BOTTOM) into a
    // single ingredients array. The frontend uses the "side" field
    // to determine where each item is displayed on the recipe card.
    //
    // IDs and displayOrder are assigned sequentially so the
    // frontend can sort and reference items.
    const recipe = {
      id: Date.now(),
      storeId: null,
      name: foodDescription.split(".")[0].trim() || "Unknown",
      identified: foodDescription,
      categoryId: null,
      ingredients: [
        // Ingredients → side: "TOP"
        ...ingredients.map((name, i) => ({
          id: i + 1,
          name,
          cost: 0,
          side: "TOP",
          displayOrder: i + 1,
        })),
        // Instructions → side: "BOTTOM"
        // IDs continue after ingredients to avoid duplicates
        ...instructions.map((name, i) => ({
          id: ingredients.length + i + 1,
          name,
          cost: 0,
          side: "BOTTOM",
          displayOrder: ingredients.length + i + 1,
        })),
      ],
    };

    return Response.json(recipe, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return Response.json(
      { error: "Identification failed", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}
