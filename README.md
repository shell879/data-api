# Data API Worker

## Deploy
1. npm install -g wrangler
2. wrangler login
3. wrangler kv namespace create DATA
4. Paste the namespace ID into wrangler.toml
5. wrangler kv key put --namespace-id=YOUR_ID "appData" --path=./data.json
6. wrangler kv key put --namespace-id=YOUR_ID "christmasData" --path=./christmas.json
7. wrangler deploy

## Update JSON later
wrangler kv key put --namespace-id=YOUR_ID "appData" --path=./data.json

The Christmas admin uses `/api/christmas`, backed by the `christmasData` KV key.
Update it with:

```powershell
wrangler kv key put --namespace-id=YOUR_ID "christmasData" --path=./christmas.json
```
