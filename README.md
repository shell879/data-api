# Data API Worker

## Deploy
1. npm install -g wrangler
2. wrangler login
3. wrangler kv namespace create DATA
4. Paste the namespace ID into wrangler.toml
5. wrangler kv key put --namespace-id=YOUR_ID "appData" --path=./data.json
6. wrangler deploy

## Update JSON later
wrangler kv key put --namespace-id=YOUR_ID "appData" --path=./data.json

`/api/christmas` is shared by the older Christmas pages and MyNutrition. The
Worker selects the signed-in user's active store and reads or writes
`store:<storeId>:christmasData`; it does not use a single global `christmasData`
key. New stores are initialized with empty recipe data. To import a JSON file
into an existing store, replace `STORE_ID` with that store's ID:

```powershell
wrangler kv key put --namespace-id=YOUR_ID "store:STORE_ID:christmasData" --path=./christmas.json
```

`POST /api/identify` also accepts JSON such as `{"name":"cherry cake"}` to
generate a suggested recipe from a dish name. Food-photo uploads continue to
use multipart form data. Both use the AI Gateway's per-user tracking; generated
recipes should be reviewed before saving and may not match a restaurant's original.

The root `christmas.json` file is only an import/local-data source; changing it
does not automatically update any store in KV.
