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
//   • /api/christmas   — GET/POST active recipe data scoped by app and store
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

    const storeRoutes = ["/api/christmas", "/api/my-stores", "/api/join-store", "/api/switch-store"];
    if (!storeRoutes.includes(url.pathname) && storeRoutes.some((route) => url.pathname.startsWith(route))) {
      return Response.json({ error: "Not found" }, {
        status: 404, headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    if (storeRoutes.includes(url.pathname)) {
      const app = url.searchParams.get("app");
      if (app !== "recipeBuilder" && app !== "myNutrition") {
        return Response.json(
          { error: "An app selection is required. Refresh the page to use the latest version." },
          { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
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
    // Accepts a food photo as multipart/form-data, or JSON with a recipe name.
    // Step 1: Vision model identifies the food in 1-3 words.
    // Step 2: Text LLM generates a full recipe (ingredients + instructions).
    // Returns a structured recipe object.
    // Routed through AI Gateway for caching and spend tracking.
    if (url.pathname === "/api/identify" && request.method === "POST") {
      if ((request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
        return handleRecipeName(request, env, ctx);
      }
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
    // GET/POST /api/christmas → active store recipes for the selected app.
    // GET/POST /api/data      → shared global app data
    //
    // For /api/christmas, we look up the user's active store and
    // use "store:<storeId>:christmasData". The URL name is historical;
    // separate app lists determine which stores are available.
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
      try {
        const { appState } = await getAppUser(env, ctx, request);
        key = `store:${appState.activeStore}:christmasData`;
      } catch (error) {
        console.error("Could not load active store:", error);
        return Response.json({ error: "Could not load active store", message: error.message }, {
          status: 500, headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    } else {
      key = "appData";
    }

    // POST — write data to KV
    if (request.method === "POST") {
      let body = await request.text();
      if (url.pathname === "/api/christmas") {
        try {
          const data = JSON.parse(body);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an object");
          data.appType = url.searchParams.get("app");
          body = JSON.stringify(data);
        } catch (error) {
          return Response.json({ error: "Invalid recipe data", message: error.message }, {
            status: 400, headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
      }
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
// Helper: Load and initialize an app-specific store list
// ──────────────────────────────────────────────────────────────
// Existing untyped stores belong to Recipe Builder.
async function getAppUser(env, ctx, request) {
  const app = new URL(request.url).searchParams.get("app");
  const email = await getEmail(env, ctx, request);
  const userKey = `user:${email}`;
  const raw = await env.DATA.get(userKey);
  const user = raw ? JSON.parse(raw) : { email, created: new Date().toISOString() };
  let changed = !raw;
  if (!user.apps) {
    user.apps = {};
    const legacyStores = Array.isArray(user.stores) ? user.stores : user.storeId ? [user.storeId] : [];
    if (legacyStores.length) {
      user.apps.recipeBuilder = {
        stores: legacyStores,
        activeStore: user.activeStore || legacyStores[0],
      };
    }
    changed = true;
  }
  if (!user.apps[app]) {
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    const storeId = (random[0] & 0x1fffff) * 0x100000000 + random[1];
    if (!storeId || await env.DATA.get(`store:${storeId}:christmasData`)) {
      throw new Error("Could not allocate a unique store number. Please retry.");
    }
    const name = app === "myNutrition" ? `${email.split("@")[0]}MyNutritionStore` : "My Recipes";
    await env.DATA.put(`store:${storeId}:christmasData`, JSON.stringify({
      appType: app,
      stores: [{ id: 1, name, active: true, flavorProfiles: [] }],
      categories: [],
      drinkRecipes: [],
    }));
    user.apps[app] = { stores: [storeId], activeStore: storeId };
    changed = true;
  }
  const appState = user.apps[app];
  if (!Array.isArray(appState.stores) || !appState.stores.includes(appState.activeStore)) {
    throw new Error("The app store list is invalid.");
  }
  if (changed) await env.DATA.put(userKey, JSON.stringify(user));
  return { app, appState, user, userKey };
}

// ──────────────────────────────────────────────────────────────
// Handler: Join a shared store
// ──────────────────────────────────────────────────────────────
// POST /api/join-store?app=recipeBuilder|myNutrition
// Body: { storeId: <number> }
//
// Adds the given storeId to the user's stores list and makes it
// the active store. A store can only be joined in its own app.
async function handleJoinStore(request, env, ctx) {
  try {
    const body = await request.json();
    const storeId = Number(body.storeId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return Response.json(
        { error: "storeId required" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const { app, appState, user, userKey } = await getAppUser(env, ctx, request);
    const data = await env.DATA.get(`store:${storeId}:christmasData`);
    if (!data) {
      return Response.json({ error: "Store not found" }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const storeApp = JSON.parse(data).appType || "recipeBuilder";
    if (storeApp !== app) {
      return Response.json({ error: "This store belongs to a different app." }, { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (!appState.stores.includes(storeId)) appState.stores.push(storeId);
    appState.activeStore = storeId;

    await env.DATA.put(userKey, JSON.stringify(user));

    return Response.json(
      { success: true, stores: appState.stores, activeStore: appState.activeStore },
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
// POST /api/switch-store?app=recipeBuilder|myNutrition
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
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return Response.json(
        { error: "storeId required" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const { appState, user, userKey } = await getAppUser(env, ctx, request);

    // Security check: user must already have access to this store
    if (!appState.stores.includes(storeId)) {
      return Response.json(
        { error: "You don't have access to this store" },
        { status: 403, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    appState.activeStore = storeId;
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
// GET /api/my-stores?app=recipeBuilder|myNutrition
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
    const { appState } = await getAppUser(env, ctx, request);

    // Fetch each store's name from its christmasData in KV.
    // We use Promise.all to fetch all stores in parallel for speed.
    const stores = await Promise.all(
      appState.stores.map(async (storeId, index) => {
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
          active: storeId === appState.activeStore,
          owned: index === 0,
        };
      })
    );

    return Response.json(
      { stores },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } }
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
//     Takes the food description from step 1 and generates a short
//     recipe title plus INGREDIENTS and INSTRUCTIONS sections.
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
    return await generateRecipe(foodDescription, email, env, foodDescription);
  } catch (err) {
    return Response.json(
      { error: "Identification failed", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}

// JSON requests use the same routed endpoint and recipe generator as food photos.
async function handleRecipeName(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Enter a valid recipe name." },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
  const description = typeof body?.name === "string" ? body.name.trim() : "";
  if (!description || description.length > 200) {
    return Response.json(
      { error: "Enter a recipe name of 1 to 200 characters." },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  try {
    const email = await getEmail(env, ctx, request);
    if (!email) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
    return await generateRecipe(description, email, env);
  } catch (err) {
    return Response.json(
      { error: "Recipe generation failed", message: err.message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}

async function generateRecipe(foodDescription, email, env, identified) {

    // ── Step 2: Text LLM generates the recipe ───────────────
    // Given the vision description, the text model writes a short
    // title and a full recipe with labeled sections:
    //   NAME — a short recipe title, not a description or sentence
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
              "You are a recipe generator. Given a food description, write a complete recipe. Start with NAME: followed on the same line by a short recipe title of 1 to 10 words, not a sentence or description. Then output two sections labeled exactly INGREDIENTS and INSTRUCTIONS. Under INGREDIENTS, list each ingredient on its own line. Under INSTRUCTIONS, list each step on its own line. Do not include anything else — no author, no source, no commentary, no sub-recipes.",
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
    const ingHeader = /^[ \t]*(?:\*\*)?INGREDIENTS(?:\*\*)?[ \t]*:?(?:\*\*)?[ \t]*$/im.exec(raw);
    const instrHeader = /^[ \t]*(?:\*\*)?INSTRUCTIONS(?:\*\*)?[ \t]*:?(?:\*\*)?[ \t]*$/im.exec(raw);
    const titleMatch = raw.match(/^[ \t]*(?:\*\*)?NAME(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(?:\*\*)?([^\r\n*]+?)(?:\*\*)?[ \t]*$/im);
    const title = titleMatch?.[1].trim().replace(/[.!?]+$/, "").trim();
    if (!title || title.split(/\s+/).length > 10 || /^(?:this|the image|the photo|the picture|i (?:see|think|can))\b/i.test(title)) {
      return Response.json(
        { error: "Could not determine a short recipe name. Please try again." },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
    if (!ingHeader || !instrHeader || titleMatch.index > ingHeader.index || ingHeader.index >= instrHeader.index) {
      return Response.json(
        { error: "Could not read the generated ingredients and instructions. Please try again." },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    let ingredients = [];
    let instructions = [];

    {
      // ── Normal case: both headers found ──────────────────
      // Extract text between INGREDIENTS and INSTRUCTIONS,
      // then text after INSTRUCTIONS.
      const ingText = raw.slice(ingHeader.index + ingHeader[0].length, instrHeader.index).trim();
      const instrText = raw.slice(instrHeader.index + instrHeader[0].length).trim();

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
    }
    if (!ingredients.length || !instructions.length) {
      return Response.json(
        { error: "The generated recipe is missing ingredients or instructions. Please try again." },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } }
      );
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
      name: title,
      ...(identified !== undefined ? { identified } : {}),
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
}
