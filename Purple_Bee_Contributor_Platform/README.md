# Purple Bee Contributor Platform MVP

This folder contains an MVP scaffold for a contribution-based distributed compute platform.

Goals:
- Free users can use basic AI with limits.
- Contributor subscribers can reserve compute time and earn premium access.
- Actual device hardware inspection is performed by a native contributor client, not by the website alone.
- Small tasks are distributed safely and retried when needed.

Contents:
- `ARCHITECTURE.md`: MVP architecture and product rules
- `server/`: Node.js coordinator API
- `client/`: Node.js contributor client
- `worker/`: Python task runner used by the client

Quick start:

## 1. Start the coordinator server

```bash
cd server
npm install
npm run dev
```

Default URL:
- `http://localhost:8787`

## 2. Start a contributor client

```bash
cd client
copy config.example.json config.json
npm install
npm start
```

Update `config.json` to point to the server and set:
- `userId`
- `deviceName`
- `reservation` window

## 3. What this MVP already demonstrates

- contributor registration
- hardware collection via native app
- reservation-based contribution windows
- queue claim / complete flow
- contribution scoring
- premium activation
- missed reservation penalty escalation
- background Python task execution

## 4. Important product note

If Purple Bee needs to show the user's real CPU / RAM / disk hardware, the website alone cannot do that reliably.
That requires a native helper or contributor client app with explicit user consent.
