# Fuckk
# Baileys Pair API

## Setup

```bash
npm install
node index.js
```

## Usage

```
GET /pp/pair?number=91XXXXXXXXXX&url=https://image-url.jpg
```

### Parameters
| Param | Required | Description |
|-------|----------|-------------|
| `number` | ✅ | Phone with country code (no + or spaces) |
| `url` | ✅ | Image URL — will be set as DP after linking |

### Example
```
https://mydomain.com/pp/pair?number=917288837763&url=https://i.imgur.com/abc.jpg
```

### Response
```json
{
  "success": true,
  "number": "+917288837763",
  "pair_code": "ABCD-EFGH",
  "message": "WA → Settings → Linked Devices → Link with phone number",
  "dp_status": "DP will be set automatically after linking"
}
```

## Flow
1. API request aata hai number + image URL ke saath
2. Baileys socket banta hai, pair code generate hota hai
3. User WA me code enter karta hai → device link hota hai
4. Auto: image download hoti hai URL se, DP set ho jaata hai
5. Session cleanup

## Deploy (PM2)
```bash
npm install -g pm2
pm2 start index.js --name pair-api
pm2 save
```

## Port
Default: `3000`  
Change: `PORT=8080 node index.js`
