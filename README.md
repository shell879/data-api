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
