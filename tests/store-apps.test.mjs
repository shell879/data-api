import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = await readFile(new URL("../data-api-worker.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function setup() {
  const records = new Map();
  const env = {
    DATA: {
      get: async (key) => records.get(key) ?? null,
      put: async (key, value) => records.set(key, value),
    },
  };
  async function call(email, path, body) {
    const request = new Request(`https://example.invalid/api/${path}`, body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ctx = { access: { getIdentity: async () => ({ email }) } };
    const response = await worker.fetch(request, env, ctx);
    return { status: response.status, data: await response.json() };
  }
  return { records, call };
}

test("migrates existing stores and keeps app selections independent", async () => {
  const { records, call } = setup();
  const email = "alex@example.invalid";
  records.set(`user:${email}`, JSON.stringify({ email, stores: [101, 202], activeStore: 202 }));
  for (const id of [101, 202]) {
    records.set(`store:${id}:christmasData`, JSON.stringify({
      stores: [{ id: 1, name: `Old ${id}` }], categories: [], drinkRecipes: [],
    }));
  }
  const oldData = records.get("store:202:christmasData");
  assert.equal((await call(email, "christmas?app=recipeBuilder")).data.stores[0].name, "Old 202");
  const created = await call(email, "christmas?app=myNutrition");
  assert.equal(created.data.stores[0].name, "alexMyNutritionStore");
  assert.equal(created.data.appType, "myNutrition");
  const user = JSON.parse(records.get(`user:${email}`));
  const nutrition = user.apps.myNutrition.activeStore;
  assert.deepEqual(user.apps.recipeBuilder, { stores: [101, 202], activeStore: 202 });
  assert.equal(records.get("store:202:christmasData"), oldData);
  assert.equal((await call(email, "join-store?app=myNutrition", { storeId: 101 })).status, 403);
  assert.equal((await call(email, "join-store?app=recipeBuilder", { storeId: nutrition })).status, 403);
  assert.equal((await call(email, "join-store?app=recipeBuilder", { storeId: 999 })).status, 404);
  assert.equal((await call(email, "switch-store?app=recipeBuilder", { storeId: 101 })).status, 200);
  assert.equal((await call(email, "my-stores?app=myNutrition")).data.stores[0].storeId, nutrition);
  const list = (await call(email, "my-stores?app=recipeBuilder")).data.stores;
  assert.equal(list[0].active, true);
  assert.equal(list[0].owned, true);
  assert.equal((await call(email, "christmas")).status, 400);
});

test("joins same-app stores and preserves their type when saved", async () => {
  const { records, call } = setup();
  const owner = "owner@example.invalid";
  const guest = "guest@example.invalid";
  await call(owner, "christmas?app=myNutrition");
  const storeId = JSON.parse(records.get(`user:${owner}`)).apps.myNutrition.activeStore;
  await call(guest, "christmas?app=myNutrition");
  assert.equal((await call(guest, "join-store?app=myNutrition", { storeId })).status, 200);
  const list = (await call(guest, "my-stores?app=myNutrition")).data.stores;
  assert.equal(list.find((store) => store.storeId === storeId).owned, false);
  assert.equal(list.find((store) => store.storeId === storeId).active, true);
  assert.equal((await call(guest, "christmas?app=myNutrition", {
    stores: [{ id: 1, name: "Renamed" }], categories: [], drinkRecipes: [],
  })).status, 200);
  assert.equal(JSON.parse(records.get(`store:${storeId}:christmasData`)).appType, "myNutrition");
});

test("migrates legacy single-store records", async () => {
  const { records, call } = setup();
  records.set("user:old@example.invalid", JSON.stringify({ storeId: 321 }));
  records.set("store:321:christmasData", JSON.stringify({
    stores: [{ id: 1, name: "Old" }], categories: [], drinkRecipes: [],
  }));
  const list = await call("old@example.invalid", "my-stores?app=recipeBuilder");
  assert.equal(list.data.stores[0].storeId, 321);
  assert.equal(list.data.stores[0].active, true);
  assert.equal(list.data.stores[0].owned, true);
});

test("wildcard routes do not expose unrelated paths as global data", async () => {
  const { records, call } = setup();
  records.set("appData", JSON.stringify({ existing: true }));
  for (const route of ["christmas", "my-stores", "join-store", "switch-store"]) {
    assert.equal((await call("alex@example.invalid", `${route}-extra`)).status, 404);
    assert.equal((await call("alex@example.invalid", `${route}-extra`, { replacement: true })).status, 404);
  }
  assert.equal(records.get("appData"), JSON.stringify({ existing: true }));
});
