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

`/api/christmas`, `/api/my-stores`, `/api/join-store`, and `/api/switch-store`
require `?app=recipeBuilder` or `?app=myNutrition`. Each app has its own store
list and active selection under `apps` in `user:<email>`. Existing memberships
and active selections migrate to Recipe Builder; their recipe-data keys are
unchanged. A first MyNutrition visit creates a separate empty store named after
the email prefix followed by `MyNutritionStore`. Store JSON has `appType`;
existing untyped stores are Recipe Builder stores. Joining a store from the
other app is rejected. Store numbers still identify
`store:<storeId>:christmasData`. KV is eventually consistent and does not
support atomic updates: simultaneous changes can overwrite user or store
updates, including during first-time migration. Back up KV before migration.
Use the updated site and Worker together; older clients receive an app-selection
error instead of accessing the wrong app's data.

The four app-specific Worker routes must end in `*` in the deployed route
configuration: Cloudflare matches the entire URL, including its query string.
The Worker rejects other paths caught by these wildcard prefixes.

To import a JSON file into an existing store, replace `STORE_ID` with that
store's ID:

```powershell
wrangler kv key put --namespace-id=YOUR_ID "store:STORE_ID:christmasData" --path=./christmas.json
```

`POST /api/identify` also accepts JSON such as `{"name":"cherry cake"}` to
generate a suggested recipe from a dish name. Food-photo uploads continue to
use multipart form data. Both use the AI Gateway's per-user tracking; generated
recipes should be reviewed before saving and may not match a restaurant's original.

When importing a MyNutrition store, include `"appType":"myNutrition"` in the
root JSON object so it can be joined from MyNutrition.
The root `christmas.json` file is only an import/local-data source; changing it
does not automatically update any store in KV.
