export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight for local development ──────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }
    // ── Image scan endpoint ──────────────────────────────────
    if (url.pathname === "/api/scan" && request.method === "POST") {
      return handleScan(request, env);
    }
        // ── Food identification endpoint ──────────────────────────
    if (url.pathname === "/api/identify" && request.method === "POST") {
      return handleIdentify(request, env);
    }


    // ── Existing data routes ─────────────────────────────────
    const key = url.pathname === "/api/christmas"
      ? "christmasData"
      : "appData";

    if (request.method === "POST") {
      const body = await request.text();
      await env.DATA.put(key, body);
      return new Response(JSON.stringify({ success: true, bytes: body.length }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

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

// ── Image → structured JSON via vision model ──────────────────
async function handleScan(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json(
        { error: "No file uploaded. Use field name 'file'." },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

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

    const systemPrompt = [
      "Extract ALL visible text from this image.",
      "Output each line of text exactly as it appears, one per line.",
      "Do not add descriptions, commentary, or formatting — just the raw text lines.",
    ].join("\n");

    const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "List every line of text you can read in this image." },
      ],
      image: dataUri,
      max_tokens: 2048,
    });

    const raw = response.response || response.result || "";

    // First try: model returned JSON directly
    let extracted;
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        extracted = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      } catch {}
    }

    // Fallback: parse plain text lines into name + ingredients
    if (!extracted) {
      const lines = raw
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !/^(here is|the image|this (image|picture|photo)|i (can|would|see)|to extract)/i.test(l))
        .filter(l => !/^[\*\-•#]+$/.test(l))
        .map(l => l.replace(/^[\*\-•\u2022]\s*/, "").replace(/^#+\s*/, "").trim())
        .filter(l => l.length > 1);

      if (lines.length === 0) {
        return Response.json(
          { error: "Could not parse model output", raw },
          { status: 502, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }

      // First line is the name, rest are ingredients
      // Skip lines that look like section headers
      const name = lines[0];
      const ingredients = lines
        .slice(1)
        .filter(l => !/^(ingredients?|equipment|instructions?|directions?|method):?\s*$/i.test(l))
        .map(l => ({ name: l, side: "TOP" }));

      extracted = { name, ingredients };
    }

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
// ── Food photo → identify → generate recipe ──────────────────
async function handleIdentify(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json(
        { error: "No file uploaded. Use field name 'file'." },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

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

    // Step 1: Vision model identifies the food
    const visionResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      messages: [
        {
          role: "system",
                    content: "Identify the food in this image in 1-3 words. Include flavor and key toppings if visible. Examples: 'orange cake', 'chocolate chip cookies', 'pepperoni pizza'. Reply with only the food name, nothing else.",
},
        { role: "user", content: "What food is in this image?" },
      ],
      image: dataUri,
      max_tokens: 256,
    });

    const foodDescription = visionResult.response || visionResult.result || "unknown food";

        // Step 2: Text LLM generates recipe as plain text
    const recipeResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        {
          role: "system",
          content: "You are a recipe generator. Given a food description, write a complete recipe. Output two sections labeled exactly INGREDIENTS and INSTRUCTIONS. Under INGREDIENTS, list each ingredient on its own line. Under INSTRUCTIONS, list each step on its own line. Do not include anything else — no author, no source, no commentary, no sub-recipes.",
        },
        { role: "user", content: `Write a recipe for: ${foodDescription}` },
      ],
      max_tokens: 2048,
    });

    const raw = recipeResult.response || recipeResult.result || "";

    // Parse plain text: INGREDIENTS section = TOP, INSTRUCTIONS section = BOTTOM
    const upperRaw = raw.toUpperCase();
    const ingStart = upperRaw.indexOf("INGREDIENTS");
    const instrStart = upperRaw.indexOf("INSTRUCTIONS");

    let ingredients = [];
    let instructions = [];

    if (ingStart !== -1 && instrStart !== -1 && ingStart < instrStart) {
      const ingText = raw.slice(ingStart + 12, instrStart).trim();
      const instrText = raw.slice(instrStart + 13).trim();

      ingredients = ingText
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !/^ingredients?\s*:?\s*$/i.test(l))
        .map(l => l.replace(/^[\*\-•\u2022]\s*/, "").replace(/^\d+\.\s*/, "").trim())
        .filter(l => l.length > 1);

      instructions = instrText
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !/^instructions?\s*:?\s*$/i.test(l))
        .map(l => l.replace(/^[\*\-•\u2022]\s*/, "").trim())
        .filter(l => l.length > 1);
    } else {
      // Fallback: no section headers, split by line
      const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 1);
      ingredients = lines;
    }

    const recipe = {
      id: Date.now(),
      storeId: null,
      name: foodDescription.split(".")[0].trim() || "Unknown",
      identified: foodDescription,
      categoryId: null,
      ingredients: [
        ...ingredients.map((name, i) => ({ id: i + 1, name, cost: 0, side: "TOP", displayOrder: i + 1 })),
        ...instructions.map((name, i) => ({ id: ingredients.length + i + 1, name, cost: 0, side: "BOTTOM", displayOrder: ingredients.length + i + 1 })),
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
