# Peptide Customer Service MVP

Minimal Node.js + Express customer service automation for a peptide wholesale business.

## File Structure

```text
api/
  .env.example
  .gitignore
  README.md
  package.json
  package-lock.json
  products.json
  prompt.md
  src/
    saleSmartlyClient.js
    server.js
```

Runtime-generated:

```text
api/
  conversations.jsonl
```

## Install

```bash
cd api
npm install
cp .env.example .env
```

Edit `.env` and set:

```bash
OPENAI_API_KEY=your_key_here
PORT=3000
SALES_SMARTLY_VERIFY_SIGNATURE=false
SALES_SMARTLY_WEBHOOK_SECRET=
SALES_SMARTLY_API_TOKEN=your_salesmartly_api_token_here
SALES_SMARTLY_ACTIVE_SEND=true
SALES_SMARTLY_SEND_BODY_FORMAT=salesmartly_session_text
SALES_SMARTLY_SIGNATURE_ORDER=alpha
SALES_SMARTLY_RECIPIENT_ID_MODE=channel_uid
```

The backend reads the API key only from `process.env.OPENAI_API_KEY`. Never expose it to frontend code.

## Run

```bash
npm run dev
```

Or:

```bash
npm start
```

## Routes

### Health

```bash
curl http://localhost:3000/health
```

Expected:

```json
{ "ok": true }
```

### Test OpenAI

```bash
curl http://localhost:3000/api/test-openai
```

Expected:

```json
{
  "ok": true,
  "message": "OpenAI connected"
}
```

### Product Search

```bash
curl -X POST http://localhost:3000/api/product-search \
  -H "Content-Type: application/json" \
  -d '{"query":"semaglutide"}'
```

Expected:

```json
{
  "products": [
    {
      "sku": "SEM-5MG",
      "name": "Semaglutide",
      "aliases": ["semaglutide", "sema", "glp-1"],
      "category": "Weight management",
      "spec": "5mg vial",
      "price": "$39"
    }
  ],
  "quote_table": "| SKU | Product | Spec | Price |..."
}
```

### Generate Reply

```bash
curl -X POST http://localhost:3000/api/generate-reply \
  -H "Content-Type: application/json" \
  -d '{"message":"Can you send price for BPC?"}'
```

Expected reply includes:

```text
| SKU | Product | Spec | Price |
```

### Human Takeover

```bash
curl -X POST http://localhost:3000/api/generate-reply \
  -H "Content-Type: application/json" \
  -d '{"message":"What dosage should I inject?"}'
```

Expected:

```json
{
  "human_takeover": true,
  "reply": "I can share general product information, but I can’t provide personal medical, dosage, or injection instructions. For anything related to dosage, injection frequency, or medical conditions, it’s best to confirm with a licensed healthcare professional. I can still help with product options, pricing, COA, shipping, and order details."
}
```

### SaleSmartly Webhook

`POST /webhook/salesmartly` accepts the official SaleSmartly incoming message payload.

```bash
curl -X POST http://localhost:3000/webhook/salesmartly \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "data": {
      "chat_user_id": "65094291e106072b7e40ff21",
      "sequence_id": "1695787977126000",
      "msg_type": "text",
      "msg": "How much is Reta 30mg?",
      "send_time": "1695787977082",
      "chat_session_id": 130925,
      "chat_session_encrypt_id": "optional_encrypted_id",
      "channel": 1,
      "channel_uid": "facebook_or_channel_user_id",
      "sender_type": 1,
      "sender": "65094291e106072b7e40ff21",
      "sys_user_id": 0,
      "channel_name": "Messenger Page Name"
    }
  }'
```

Default expected response uses SaleSmartly's direct-response shape:

```json
{
  "code": 0,
  "msg": "Success",
  "data": {
    "msg_type": 1,
    "msg": "Sure, this is Steve...",
    "chat_user_id": "65094291e106072b7e40ff21",
    "chat_session_id": "130925",
    "send_time": "1770000000000",
    "channel": 1,
    "channel_uid": "facebook_or_channel_user_id",
    "channel_name": "Messenger Page Name"
  }
}
```

For local testing, append `?debug=1`:

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{
    "event":"message",
    "data":{
      "chat_user_id":"65094291e106072b7e40ff21",
      "sequence_id":"1695787977126000",
      "msg_type":"text",
      "msg":"How much is Reta 30mg?",
      "send_time":"1695787977082",
      "chat_session_id":130925,
      "channel":1,
      "channel_uid":"facebook_or_channel_user_id",
      "sender_type":1,
      "channel_name":"Messenger Page Name"
    }
  }'
```

Debug response:

```json
{
  "success": true,
  "reply": "...",
  "human_takeover": false,
  "lead_stage": "quoted",
  "matched_products": []
}
```

The helper function `formatSaleSmartlyResponse()` in `server.js` controls the official webhook response body. If SaleSmartly requires a different JSON shape for auto-replies, update that function only.

Signature verification is disabled by default because the exact signing base string should be confirmed in your SaleSmartly account docs/settings:

```bash
SALES_SMARTLY_VERIFY_SIGNATURE=false
```

If enabled, SaleSmartly may call:

```text
https://your-domain.com/webhook/salesmartly?timestamp=TIMESTAMP&signature=SIGNATURE
```

There is also a prepared active-send helper, `sendSaleSmartlyMessengerMessage()`, for future use with:

```text
POST https://webhook.salesmartly.com/messenger/send
```

It is controlled by:

```bash
SALES_SMARTLY_ACTIVE_SEND=true
```

When `SALES_SMARTLY_ACTIVE_SEND=false`, the webhook returns the direct-response JSON above. When `SALES_SMARTLY_ACTIVE_SEND=true`, the webhook calls SaleSmartly Messenger Send API and returns:

```json
{
  "code": 0,
  "msg": "Success"
}
```

### SaleSmartly Active Send

Enable active send locally:

```bash
SALES_SMARTLY_API_TOKEN=your_salesmartly_api_token_here
SALES_SMARTLY_ACTIVE_SEND=true
SALES_SMARTLY_SEND_BODY_FORMAT=salesmartly_session_text
SALES_SMARTLY_SIGNATURE_ORDER=alpha
SALES_SMARTLY_RECIPIENT_ID_MODE=channel_uid
```

Required Render environment variables:

```bash
SALES_SMARTLY_API_TOKEN=your_salesmartly_api_token_here
SALES_SMARTLY_ACTIVE_SEND=true
SALES_SMARTLY_SEND_BODY_FORMAT=salesmartly_session_text
SALES_SMARTLY_SIGNATURE_ORDER=alpha
SALES_SMARTLY_RECIPIENT_ID_MODE=channel_uid
SALES_SMARTLY_VERIFY_SIGNATURE=false
```

The active-send client uses:

```text
POST https://webhook.salesmartly.com/messenger/send
```

The active-send body format is controlled by:

```bash
SALES_SMARTLY_SEND_BODY_FORMAT=salesmartly_session_text
```

Supported values:

- `salesmartly_session_text`: send a text message using `chat_user_id` and `chat_session_id`
- `salesmartly_session_template`: send a template text message using `chat_user_id` and `chat_session_id`
- `official_to_text`: send the confirmed `to` + text format

If `SALES_SMARTLY_SEND_BODY_FORMAT` is not set, the backend defaults to `salesmartly_session_text`.

For `salesmartly_session_text`, the active-send body is:

```json
{
  "data": {
    "msg_type": 1,
    "msg": "Test message from AI backend",
    "chat_user_id": "CHAT_USER_ID",
    "chat_session_id": "130925",
    "send_time": "1778936424419",
    "channel": 1
  }
}
```

For `salesmartly_session_template`, the active-send body is:

```json
{
  "data": {
    "msg_type": 3,
    "msg": {
      "template1": {
        "text": "Test message from AI backend"
      }
    },
    "chat_user_id": "CHAT_USER_ID",
    "chat_session_id": "130925",
    "send_time": "1778936424419",
    "channel": 1,
    "tag": "CONFIRMED_EVENT_UPDATE"
  }
}
```

For `official_to_text`, the active-send body is:

```json
{
  "to": "RECIPIENT_ID",
  "message_type": "text",
  "data": {
    "text": "Test message from AI backend"
  }
}
```

The request URL includes `signature` and Unix-seconds `timestamp`. The signature is MD5 of:

```text
token&data=<JSON body>&timestamp=<timestamp>
```

Set `SALES_SMARTLY_SIGNATURE_ORDER=timestamp_data` only if SaleSmartly asks you to test `token&timestamp=...&data=...`. Do not hard-code or log the token.

Recipient ID selection is controlled by:

```bash
SALES_SMARTLY_RECIPIENT_ID_MODE=channel_uid
```

Supported modes:

- `chat_user_id`: use `data.chat_user_id`
- `psid`: use `data.chat_user.channelUid`, then `channelInfo.psid`
- `channel_uid`: use `data.channel_uid`
- `chat_session_id`: use `String(data.chat_session_id)`
- `channel_id`: use `String(data.channel_id)`
- `chat_user_chatUserId`: use `data.chat_user.chatUserId`
- `auto`: try `chat_user_id`, `chat_user.channelUid`, `channelInfo.psid`, `channel_uid`, `chat_session_id`, `channel_id`, then `chat_user.chatUserId`

Test active send directly:

```bash
curl -X POST http://localhost:3000/api/test-salesmartly-send \
  -H "Content-Type: application/json" \
  -d '{
    "recipient_id": "26746728614994663",
    "chat_user_id": "e5b4d759697aed8146b5c4d6e466a71e",
    "chat_session_id": "849390414",
    "channel": 1,
    "replyText": "Test message from AI backend"
  }'
```

If the token is missing or invalid, this endpoint returns an error and logs the failure without printing the token.

## Conversation Logging

Every call to `/api/generate-reply` and `/webhook/salesmartly` appends one JSON line to:

```text
conversations.jsonl
```

The log does not include the OpenAI API key.

Current log fields:

```json
{
  "route": "/webhook/salesmartly",
  "customer_id": "65094291e106072b7e40ff21",
  "session_id": "130925",
  "channel": 1,
  "channel_uid": "facebook_or_channel_user_id",
  "channel_name": "Messenger Page Name",
  "platform": "messenger",
  "incoming_message": "How much is Reta 30mg?",
  "ai_reply": "...",
  "matched_products": [],
  "human_takeover": false,
  "lead_stage": "quoted",
  "timestamp": "2026-05-14T00:00:00.000Z",
  "raw_event_id": "1695787977126000"
}
```

## SaleSmartly/Messenger Test Curls

### Customer asks for catalog

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"chat_user_id":"cust_catalog","sequence_id":"seq_catalog","msg_type":"text","msg":"Can I get a price list?","send_time":"1695787977082","chat_session_id":130925,"channel":1,"channel_uid":"fb_user_catalog","sender_type":1,"channel_name":"Messenger Page Name"}}'
```

### Customer asks for Reta 30mg

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"chat_user_id":"cust_reta","sequence_id":"seq_reta","msg_type":"text","msg":"How much is Reta 30mg?","send_time":"1695787977082","chat_session_id":130925,"channel":1,"channel_uid":"fb_user_reta","sender_type":1,"channel_name":"Messenger Page Name"}}'
```

### Customer asks for shipping time

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"chat_user_id":"cust_shipping","sequence_id":"seq_shipping","msg_type":"text","msg":"How long is shipping to the US?","send_time":"1695787977082","chat_session_id":130925,"channel":1,"channel_uid":"fb_user_shipping","sender_type":1,"channel_name":"Messenger Page Name"}}'
```

### Customer asks for COA

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"chat_user_id":"cust_coa","sequence_id":"seq_coa","msg_type":"text","msg":"Do you have COA?","send_time":"1695787977082","chat_session_id":130925,"channel":1,"channel_uid":"fb_user_coa","sender_type":1,"channel_name":"Messenger Page Name"}}'
```

### Customer asks dosage question and triggers human takeover

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"chat_user_id":"cust_medical","sequence_id":"seq_medical","msg_type":"text","msg":"What dosage should I start with?","send_time":"1695787977082","chat_session_id":130925,"channel":1,"channel_uid":"fb_user_medical","sender_type":1,"channel_name":"Messenger Page Name"}}'
```

### Staff/system message is ignored

```bash
curl -X POST "http://localhost:3000/webhook/salesmartly?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"event":"message","data":{"chat_user_id":"cust_staff","sequence_id":"seq_staff","msg_type":"text","msg":"Internal staff note","send_time":"1695787977082","chat_session_id":130925,"channel":1,"channel_uid":"fb_user_staff","sender_type":2,"channel_name":"Messenger Page Name"}}'
```
