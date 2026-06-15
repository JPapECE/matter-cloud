/**
 * GatewayManager.ts
 * Manages the gateway WebSocket connections.
 */

import WebSocket from "ws";
import { dbService } from "../database/DatabaseService.js";
import { commandDispatcher } from "./CommandDispatcher.js";
import { eventBroadcaster } from "../events/EventBroadcaster.js";

class GatewayManager {
  private gatewayWs: WebSocket | null = null;
  private isAuthenticated = false;

  public handleConnection(ws: WebSocket): void {
    console.log("[GatewayManager] Connection request initiated from gateway.");

    // Start an authentication timeout (must authenticate within 5 seconds)
    const authTimeout = setTimeout(() => {
      if (!this.isAuthenticated) {
        console.warn("[GatewayManager] Authentication timeout. Closing connection.");
        ws.send(JSON.stringify({ type: "auth", success: false, error: "Authentication timeout" }));
        ws.close();
      }
    }, 5000);

    ws.on("message", async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // 1. Authenticate connection
        if (!this.isAuthenticated) {
          if (msg.type === "auth") {
            const secretToken = process.env.GATEWAY_SECRET_TOKEN;
            if (!secretToken) {
              console.error("[GatewayManager] GATEWAY_SECRET_TOKEN environment variable is missing.");
              ws.send(JSON.stringify({ type: "auth", success: false, error: "Server authentication error" }));
              ws.close();
              return;
            }

            if (msg.token === secretToken) {
              clearTimeout(authTimeout);
              this.isAuthenticated = true;
              this.gatewayWs = ws;
              console.log("[GatewayManager] Gateway successfully authenticated.");
              await dbService.saveGatewaySeen("gateway-rpi");
              ws.send(JSON.stringify({ type: "auth_ok" }));
              eventBroadcaster.broadcastToMobile({ event: "gateway_status", status: "connected" });
            } else {
              console.warn("[GatewayManager] Invalid gateway secret token. Closing.");
              ws.send(JSON.stringify({ type: "auth", success: false, error: "Unauthorized" }));
              ws.close();
            }
          } else {
            console.warn("[GatewayManager] First message must be auth payload.");
            ws.close();
          }
          return;
        }

        // 2. Process authenticated gateway payloads
        this.handleMessage(msg);
      } catch (err: any) {
        console.error("[GatewayManager] Error processing WebSocket message:", err.message);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      this.handleDisconnect();
    });

    ws.on("error", (err) => {
      console.error("[GatewayManager] WebSocket connection error:", err.message);
      ws.close();
    });
  }

  private handleDisconnect(): void {
    console.warn("[GatewayManager] Gateway WebSocket closed.");
    this.gatewayWs = null;
    this.isAuthenticated = false;

    // Cancel and reject any pending commands
    commandDispatcher.clearAllPending();

    // Dispatch disconnected status event to all mobile WS connections
    eventBroadcaster.broadcastToMobile({ event: "gateway_status", status: "disconnected" });

    // Mark all devices offline since connection to local hardware has been severed
    dbService.getAllDevices()
      .then(async (devices) => {
        for (const device of devices) {
          await dbService.updateDeviceOnlineStatus(device.nodeId, false);
          eventBroadcaster.broadcastToMobile({ event: "device_offline", nodeId: device.nodeId });
        }
      })
      .catch((err) => {
        console.error("[GatewayManager] Failed to update device online status on disconnect:", err.message);
      });
  }

  private async handleMessage(msg: any): Promise<void> {
    const { type } = msg;

    switch (type) {
      case "init_state": {
        console.log("[GatewayManager] Received state synchronization (init_state) payload.");
        const { devices, groups } = msg;
        try {
          await dbService.reconcileFromGateway(devices || [], groups || []);
          console.log("[GatewayManager] State synchronization complete.");
        } catch (err: any) {
          console.error("[GatewayManager] State reconciliation error:", err.message);
        }
        break;
      }
      case "response": {
        const { requestId } = msg;
        commandDispatcher.resolveResponse(requestId, msg);
        break;
      }
      case "event": {
        // Broadcaster handles saving events to Postgres and streaming them to mobile clients
        await eventBroadcaster.handleEvent(msg);
        break;
      }
      case "heartbeat": {
        await dbService.saveGatewaySeen("gateway-rpi");
        break;
      }
      default:
        console.warn("[GatewayManager] Unsupported payload type:", type);
    }
  }

  public getGatewayWs(): WebSocket | null {
    return this.gatewayWs;
  }

  public isGatewayConnected(): boolean {
    return this.isAuthenticated && this.gatewayWs !== null && this.gatewayWs.readyState === WebSocket.OPEN;
  }
}

export const gatewayManager = new GatewayManager();
