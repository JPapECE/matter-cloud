import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import { apiRouter } from "./routes.js";
import { groupsRouter } from "./groupsRoutes.js";
import { dbService } from "../database/DatabaseService.js";
import { gatewayManager } from "../gateway/GatewayManager.js";
import { eventBroadcaster } from "../events/EventBroadcaster.js";

const app = express();
app.use(cors());
app.use(express.json());

// Register API Routes
app.use(apiRouter);
app.use(groupsRouter);

const server = http.createServer(app);

// Setup WebSockets
const wssGateway = new WebSocketServer({ noServer: true });
const wssMobile = new WebSocketServer({ noServer: true });

wssGateway.on("connection", (ws) => {
  gatewayManager.handleConnection(ws);
});

wssMobile.on("connection", (ws) => {
  eventBroadcaster.registerMobileClient(ws);
});

// Intercept upgrade requests to route WS traffic
server.on("upgrade", (request, socket, head) => {
  const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : "";

  if (pathname === "/gateway") {
    wssGateway.handleUpgrade(request, socket, head, (ws) => {
      wssGateway.emit("connection", ws, request);
    });
  } else if (pathname === "/ws") {
    // Authenticate mobile clients via query parameter token
    try {
      const urlObj = new URL(request.url || "", `http://${request.headers.host}`);
      const token = urlObj.searchParams.get("token");
      const expectedToken = process.env.API_KEY;

      if (!expectedToken || token !== expectedToken) {
        console.warn("[WS Upgrade] Rejected unauthorized mobile WebSocket upgrade attempt.");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wssMobile.handleUpgrade(request, socket, head, (ws) => {
        wssMobile.emit("connection", ws, request);
      });
    } catch (err: any) {
      console.error("[WS Upgrade] Mobile upgrade processing error:", err.message);
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // Initialize PostgreSQL integrations and migrations
    await dbService.init();

    server.listen(PORT, () => {
      console.log(`[Server] Hosted cloud API service running on port ${PORT}`);
    });
  } catch (err: any) {
    console.error("[Fatal] Failed to bootstrap cloud service:", err.message);
    process.exit(1);
  }
}

bootstrap();
