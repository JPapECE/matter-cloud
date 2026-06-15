/**
 * EventBroadcaster.ts
 * Manages mobile WebSocket subscriptions and processes gateway events.
 */

import WebSocket from "ws";
import { dbService } from "../database/DatabaseService.js";

class EventBroadcaster {
  private mobileClients = new Set<WebSocket>();

  public registerMobileClient(ws: WebSocket): void {
    this.mobileClients.add(ws);
    console.log(`[EventBroadcaster] Mobile client linked. Active channels: ${this.mobileClients.size}`);

    ws.on("close", () => {
      this.mobileClients.delete(ws);
      console.log(`[EventBroadcaster] Mobile client detached. Active channels: ${this.mobileClients.size}`);
    });

    ws.on("error", () => {
      this.mobileClients.delete(ws);
    });
  }

  public async handleEvent(payload: any): Promise<void> {
    const { event, nodeId } = payload;
    console.log(`[EventBroadcaster] Processing event "${event}" from node: ${nodeId}`);

    try {
      if (event === "device_online") {
        await dbService.updateDeviceOnlineStatus(nodeId, true);
      } else if (event === "device_offline") {
        await dbService.updateDeviceOnlineStatus(nodeId, false);
      } else if (event === "energy_snapshot") {
        // Extract timestamp from the payload or default to current date
        const recordedAt = payload.power?.timestamp || payload.energy?.timestamp;
        await dbService.saveEnergyReading(nodeId, payload.power, payload.energy, recordedAt);
      } else if (event === "state_change") {
        // If state change attribute indicates online/offline updates
        if (payload.attribute === "online") {
          await dbService.updateDeviceOnlineStatus(nodeId, !!payload.value);
        }
      }
    } catch (err: any) {
      console.error(`[EventBroadcaster] Error updating PostgreSQL cache for event "${event}":`, err.message);
    }

    // Forward the event to all active mobile WebSocket clients
    this.broadcastToMobile(payload);
  }

  /**
   * Broadcasts a JSON message to all registered mobile clients.
   */
  public broadcastToMobile(payload: any): void {
    const raw = JSON.stringify(payload);
    for (const ws of this.mobileClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(raw);
        } catch (err: any) {
          console.error("[EventBroadcaster] Failed to send to mobile client socket:", err.message);
        }
      }
    }
  }
}

export const eventBroadcaster = new EventBroadcaster();
