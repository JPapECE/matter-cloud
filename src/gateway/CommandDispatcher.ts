/**
 * CommandDispatcher.ts
 * Manages outgoing commands to the gateway and routes responses.
 */

import crypto from "crypto";
import { gatewayManager } from "./GatewayManager.js";
import { COMMAND_TIMEOUTS } from "../types/gateway-protocol.js";
import type { CommandAction, ResponseMsg } from "../types/gateway-protocol.js";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

class CommandDispatcher {
  private pendingMap = new Map<string, PendingRequest>();

  public dispatch(action: CommandAction, nodeId?: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      // 1. Verify gateway connectivity
      if (!gatewayManager.isGatewayConnected()) {
        reject(new Error("Gateway offline (503)"));
        return;
      }

      const ws = gatewayManager.getGatewayWs();
      if (!ws) {
        reject(new Error("Gateway socket unavailable"));
        return;
      }

      // 2. Correlation Mapping
      const requestId = crypto.randomUUID();
      const timeoutMs = COMMAND_TIMEOUTS[action] || 10000;

      // 3. Set correlation timeout (504 Gateway Timeout)
      const timer = setTimeout(() => {
        this.pendingMap.delete(requestId);
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s (504)`));
      }, timeoutMs);

      // Register promise handlers in lookup map
      this.pendingMap.set(requestId, { resolve, reject, timer });

      // 4. Send command to gateway
      const commandMsg = {
        type: "command" as const,
        requestId,
        action,
        nodeId,
        payload,
      };

      try {
        ws.send(JSON.stringify(commandMsg));
        console.log(`[CommandDispatcher] Dispatched "${action}" (requestId: ${requestId}) to gateway.`);
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingMap.delete(requestId);
        reject(new Error(`Failed to transmit command: ${err.message}`));
      }
    });
  }

  public resolveResponse(requestId: string, response: ResponseMsg): void {
    const pending = this.pendingMap.get(requestId);
    if (!pending) {
      console.warn(`[CommandDispatcher] Received response for unknown/expired requestId: ${requestId}`);
      return;
    }

    // Cancel timeout timer
    clearTimeout(pending.timer);
    this.pendingMap.delete(requestId);

    // Resolve or reject the deferred promise
    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || "Gateway reported execution failure"));
    }
  }

  /**
   * Reject all pending queries. Called on gateway disconnect.
   */
  public clearAllPending(): void {
    for (const [requestId, pending] of this.pendingMap.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Gateway disconnected."));
    }
    this.pendingMap.clear();
  }
}

export const commandDispatcher = new CommandDispatcher();
