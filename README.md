# Matter Cloud Coordinator

This repository houses the **Matter Cloud Coordinator**, a central orchestration and data caching service for the multi-tenant Matter IoT system. 

It acts as a secure relay, database proxy, and real-time event broadcaster bridging the local home networks (managed by local Matter Gateways) with the mobile clients.

---

## 1. Architectural Overview

The cloud coordinator acts as the central hub of the three-tier system:

```
                                  +-------------------+
                                  |    PostgreSQL     |
                                  |  Persistent Cache |
                                  +---------+---------+
                                            |
                                            v
+-------------------+             +---------+---------+             +-------------------+
|   Local Gateway   | <=========> |  Cloud Server     | <=========> |    Mobile App     |
|  (Raspberry Pi)   |  WSS (/gw)  |  (Railway Engine) |  WSS (/ws)  |   (Expo/React)    |
+-------------------+             +---------+---------+             +-------------------+
                                            |
                                         REST API
                                            |
                                            v
                                     [Mobile Commands]
```

### Key Subsystems:
* **Gateway WebSocket Manager (`/gateway`)**: A full-duplex WebSocket channel that authenticates the local gateway connection.
* **Mobile Event Broadcaster (`/ws`)**: A secondary WebSocket server that streams real-time state change events and gateway connection statuses to active mobile users.
* **Command Dispatcher**: A request-response map that coordinates outgoing command execution. It tracks commands sent downstream with unique correlation IDs (`requestId`) and enforces customizable timeouts (configured via `COMMAND_TIMEOUTS`).
* **Database Cache Layer**: Caches device metadata, online statuses, current on/off/dimmer states, and historical energy reading analytics in PostgreSQL.

---

## 2. Directory Structure

```
matter-cloud/
├── Dockerfile             # Production multi-stage runtime build
├── package.json           # Scripts and dependency manifests
├── tsconfig.json          # TypeScript compilation configuration
└── src/
    ├── api/
    │   ├── server.ts      # Server entry point (Express + HTTP/WS Servers)
    │   ├── routes.ts      # Device control & capability REST endpoints
    │   └── groupsRoutes.ts # Matter groups CRUD proxy endpoints
    ├── auth/
    │   └── middleware.ts  # Express Static Bearer Token authorization
    ├── database/
    │   └── DatabaseService.ts # PostgreSQL migration, reconciliation, & query pool
    ├── events/
    │   └── EventBroadcaster.ts # Mobile WS registration & event dissemination
    ├── gateway/
    │   ├── GatewayManager.ts # Gateway WS connection lifecycle & init_state sync
    │   └── CommandDispatcher.ts # Correlation map for request/response command flows
    └── types/
        └── gateway-protocol.ts # Shared TypeScript communication protocol contract
```

---

## 3. Database Schema (PostgreSQL)

The database migration is run automatically on startup via `DatabaseService.ts`. It maintains 6 core tables:

1. **`devices`**:
   * Caches the primary state of local devices: `"nodeId"` (PK), `name`, `type`, `"addedAt"`, `online`, `"on"`, `level`.
2. **`device_capabilities`**:
   * Stores features discovered during commissioning: `supportsOnOff`, `supportsLevel`, `supportsColorTemp`, `supportsEnergy`, `minMireds`, `maxMireds`, `minLevel`, `maxLevel`.
3. **`energy_readings`**:
   * Stores historical power analytics forwarded from local gateways: `activePower` (W), `voltage` (V), `current` (A), `cumulativeEnergy` (Wh), `recordedAt` (timestamp).
4. **`gateways`**:
   * Tracks connected gateway heartbeats: `gatewayId` (PK), `lastSeenAt`.
5. **`groups`**:
   * Tracks Matter multicast groups: `groupId` (PK), `name`, `createdAt`.
6. **`group_members`**:
   * Junction table linking devices to groups: `groupId` (FK), `nodeId` (FK).

---

## 4. Configuration (`.env`)

Create a `.env` file in the root directory:

```env
PORT=3000
DATABASE_URL=postgresql://user:password@host:port/dbname
GATEWAY_SECRET_TOKEN=your_secure_gateway_connection_secret
API_KEY=your_mobile_client_rest_auth_key
```

* **`GATEWAY_SECRET_TOKEN`**: Must match the token configured on the local Gateway's `.env` configuration.
* **`API_KEY`**: Must match the `apiKey` configuration in the mobile app's `app.json`.

---

## 5. API Reference

All routes under `/api/*` require the `Authorization: Bearer <API_KEY>` header.

### Device Management & Control
* **`GET /api/devices`**: Lists all devices cached in the database.
* **`GET /api/devices/:id/status`**: Lightweight status check (reads online, on/off, level from Postgres cache).
* **`GET /api/devices/:id/full-status`**: Status + latest energy reading.
* **`PATCH /api/devices/:id/name`**: Renames the device in the cloud database.
* **`GET /api/devices/:id/color-temperature`**: Returns the min/max Kelvin ranges from the capabilities cache.
* **`POST /api/commission`**: Commissions a new device. Body structure:
  ```json
  {
    "pairingCode": "MT:...",
    "name": "Living Room Light",
    "type": "smart-plug",
    "wifi": { "ssid": "MyWiFi", "password": "pass" }
  }
  ```
* **`POST /api/devices/:id/on`** / **`off`**: Explicit state commands.
* **`POST /api/devices/:id/toggle`**: Sends a toggle command.
* **`POST /api/devices/:id/level`**: Changes dimming level (`level` between 1 and 254).
* **`POST /api/devices/:id/level/move`**: Continuous dimming. Parameters: `direction: "up"|"down"`, `rate`.
* **`POST /api/devices/:id/level/stop`**: Halts continuous dimming.
* **`POST /api/devices/:id/level/step`**: Increments dimming level. Parameters: `direction`, `stepSize`, `transitionTime`.
* **`POST /api/devices/:id/color-temperature`**: Changes light warmth (`mireds` or `kelvin`).

### Matter Groups Proxy
* **`GET /api/groups`**: Lists all groups and member device lists.
* **`POST /api/groups`**: Creates a new group (`groupId`, `name`).
* **`DELETE /api/groups/:id`**: Deletes a group and coordinates local fabric updates.
* **`POST /api/groups/:id/members`**: Adds a device to a group (`nodeId`).
* **`DELETE /api/groups/:id/members/:nodeId`**: Removes a device from a group.
* **`POST /api/groups/:id/on`** / **`off`** / **`toggle`**: Group broadcast actions.

---

## 6. Execution & Deployment

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server (uses `tsx watch` for auto-reloading):
   ```bash
   npm run dev
   ```

### Production Build

1. Compile TypeScript:
   ```bash
   npm run build
   ```
2. Start compiled JavaScript output:
   ```bash
   npm run start
   ```
