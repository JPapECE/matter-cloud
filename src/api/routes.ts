/**
 * routes.ts
 * Device control REST API router.
 */

import { Router } from "express";
import { dbService } from "../database/DatabaseService.js";
import { gatewayManager } from "../gateway/GatewayManager.js";
import { commandDispatcher } from "../gateway/CommandDispatcher.js";
import { requireAuth } from "../auth/middleware.js";

const router = Router();

// Helper to handle command mapping errors into appropriate HTTP responses
function handleCommandError(err: any, res: any): void {
  const message = err.message || String(err);
  if (message.includes("503") || message.includes("offline")) {
    res.status(503).json({ error: "Gateway offline" });
  } else if (message.includes("504") || message.includes("timed out")) {
    res.status(504).json({ error: "Gateway response timeout" });
  } else if (message.includes("not found") || message.includes("404")) {
    res.status(404).json({ error: message });
  } else {
    res.status(500).json({ error: message });
  }
}

// ── GET /health ─────────────────────────────────────────────────────────────
// Unprotected health check endpoint
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    gatewayOnline: gatewayManager.isGatewayConnected(),
    timestamp: new Date().toISOString(),
  });
});

// Enforce auth on all API endpoints below
router.use(requireAuth);

// ── GET /api/devices ─────────────────────────────────────────────────────────
router.get("/api/devices", async (_req, res) => {
  try {
    const devices = await dbService.getAllDevices();
    res.json(devices);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/devices/:id/capabilities ────────────────────────────────────────
router.get("/api/devices/:id/capabilities", async (req, res) => {
  const { id } = req.params;
  const forceRefresh = req.query.refresh === "true";

  try {
    let capabilities = null;
    if (!forceRefresh) {
      capabilities = await dbService.getDeviceCapabilities(id);
    }

    if (!capabilities) {
      console.log(`[API] Capabilities cache miss or force-refresh for ${id}. Dispatching discovery...`);
      // Dispatches command to gateway and awaits response
      const caps = await commandDispatcher.dispatch("discover_capabilities", id);
      await dbService.saveDeviceCapabilities(caps);
      capabilities = await dbService.getDeviceCapabilities(id);
    }

    res.json(capabilities);
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── GET /api/devices/:id/energy/history ──────────────────────────────────────
router.get("/api/devices/:id/energy/history", async (req, res) => {
  const { id } = req.params;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const since = req.query.since as string;

  try {
    const history = await dbService.getEnergyHistory(id, limit, since);
    res.json(history);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/devices/:id/energy/stats ────────────────────────────────────────
router.get("/api/devices/:id/energy/stats", async (req, res) => {
  const { id } = req.params;
  const since = req.query.since as string;

  if (!since) {
    res.status(400).json({ error: "Query parameter 'since' (ISO string) is required" });
    return;
  }

  try {
    const stats = await dbService.getEnergyStats(id, since);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ble/status ──────────────────────────────────────────────────────
router.get("/api/ble/status", async (_req, res) => {
  try {
    const status = await commandDispatcher.dispatch("ble_status");
    res.json(status);
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── POST /api/commission ─────────────────────────────────────────────────────
router.post("/api/commission", async (req, res) => {
  const { pairingCode, name, type, wifi } = req.body;

  if (!pairingCode || !name) {
    res.status(400).json({ error: "pairingCode and name are required." });
    return;
  }

  // SECURITY: Redact Wi-Fi password in cloud console log
  const logPayload = {
    pairingCode,
    name,
    type,
    wifi: wifi ? { ssid: wifi.ssid, password: "[REDACTED]" } : undefined,
  };
  console.log("[API] POST /api/commission. Triggering commissioning payload:", logPayload);

  try {
    // Gateway returns the nodeId string after commissioning completes
    const nodeId = await commandDispatcher.dispatch("commission", undefined, {
      pairingCode,
      name,
      type: type || "smart-plug",
      wifi,
    });

    // Immediately persist the device to Postgres so the dashboard shows it
    // without waiting for the next gateway reconnect + init_state reconciliation.
    // Use upsert so a re-commission of the same nodeId is idempotent.
    try {
      await dbService.upsertDevice(nodeId, name, type || "smart-plug");
      console.log(`[API] Device ${nodeId} ("${name}") written to Postgres after commission.`);
    } catch (dbErr: any) {
      // Non-fatal — device will appear on next gateway reconnect via reconcileFromGateway
      console.error(`[API] Failed to write device ${nodeId} to Postgres after commission:`, dbErr.message);
    }

    // Return both nodeId and name so the frontend can display the correct name
    res.status(201).json({ nodeId, name, success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── DELETE /api/devices/:id ──────────────────────────────────────────────────
router.delete("/api/devices/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await commandDispatcher.dispatch("decommission", id);
    await dbService.removeDevice(id);
    res.json({ success: true, decommissioned: id });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── Device Control commands ──────────────────────────────────────────────────

router.post("/api/devices/:id/on", async (req, res) => {
  const { id } = req.params;
  try {
    await commandDispatcher.dispatch("on", id);
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/off", async (req, res) => {
  const { id } = req.params;
  try {
    await commandDispatcher.dispatch("off", id);
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/toggle", async (req, res) => {
  const { id } = req.params;
  try {
    await commandDispatcher.dispatch("toggle", id);
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/level", async (req, res) => {
  const { id } = req.params;
  const { level, transitionTime } = req.body;

  if (typeof level !== "number" || level < 1 || level > 254) {
    res.status(400).json({ error: "level must be an integer between 1 and 254" });
    return;
  }

  try {
    await commandDispatcher.dispatch("level", id, { level, transitionTime });
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/color-temperature", async (req, res) => {
  const { id } = req.params;
  let { mireds, kelvin, transitionTime } = req.body;

  if (mireds == null && kelvin == null) {
    res.status(400).json({ error: "Either mireds or kelvin must be provided" });
    return;
  }

  if (mireds == null && kelvin != null) {
    if (kelvin < 1) {
      res.status(400).json({ error: "kelvin must be greater than 0" });
      return;
    }
    mireds = Math.round(1000000 / kelvin);
  }

  try {
    await commandDispatcher.dispatch("color_temperature", id, { mireds, transitionTime });
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/timed-on", async (req, res) => {
  const { id } = req.params;
  const { onTime, offWaitTime } = req.body;

  if (typeof onTime !== "number" || onTime <= 0) {
    res.status(400).json({ error: "onTime (seconds) must be a positive number" });
    return;
  }

  try {
    const data = await commandDispatcher.dispatch("timed_on", id, { onTime, offWaitTime: offWaitTime || 0 });
    res.json({ success: true, data });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── Level move / stop / step ─────────────────────────────────────────────────

router.post("/api/devices/:id/level/move", async (req, res) => {
  const { id } = req.params;
  const { direction, rate } = req.body;

  if (direction !== "up" && direction !== "down") {
    res.status(400).json({ error: "direction must be 'up' or 'down'" });
    return;
  }

  try {
    await commandDispatcher.dispatch("level_move", id, { direction, rate });
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/level/stop", async (req, res) => {
  const { id } = req.params;
  try {
    await commandDispatcher.dispatch("level_stop", id);
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/devices/:id/level/step", async (req, res) => {
  const { id } = req.params;
  const { direction, stepSize, transitionTime } = req.body;

  if (direction !== "up" && direction !== "down") {
    res.status(400).json({ error: "direction must be 'up' or 'down'" });
    return;
  }

  try {
    await commandDispatcher.dispatch("level_step", id, { direction, stepSize, transitionTime });
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── GET /api/devices/:id/status ──────────────────────────────────────────────
// Lightweight status — read from Postgres cache (no gateway round-trip)
router.get("/api/devices/:id/status", async (req, res) => {
  const { id } = req.params;
  try {
    const device = await dbService.getDevice(id);
    if (!device) {
      res.status(404).json({ error: `Device ${id} not found` });
      return;
    }
    res.json({
      nodeId: device.nodeId,
      online: device.online ?? false,
      on:     device.on    ?? null,
      level:  device.level ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/devices/:id/full-status ─────────────────────────────────────────
// Returns status + latest energy snapshot from Postgres (no gateway round-trip)
router.get("/api/devices/:id/full-status", async (req, res) => {
  const { id } = req.params;
  try {
    const device = await dbService.getDevice(id);
    if (!device) {
      res.status(404).json({ error: `Device ${id} not found` });
      return;
    }

    // Most recent energy reading from history
    const energyRows = await dbService.getEnergyHistory(id, 1);
    const latest     = energyRows[0] ?? null;

    const power: Record<string, unknown> = {
      nodeId:      id,
      activePower: latest?.activePower      ?? null,
      voltage:     latest?.voltage          ?? null,
      current:     latest?.current          ?? null,
      timestamp:   latest?.recordedAt       ?? new Date().toISOString(),
    };

    const energy: Record<string, unknown> = {
      nodeId:                   id,
      cumulativeEnergy:         latest?.cumulativeEnergy         ?? null,
      periodicEnergy:           latest?.periodicEnergy           ?? null,
      cumulativeEnergyExported: latest?.cumulativeEnergyExported ?? null,
      periodicEnergyExported:   latest?.periodicEnergyExported   ?? null,
      timestamp:                latest?.recordedAt               ?? new Date().toISOString(),
    };

    res.json({
      status: {
        nodeId: device.nodeId,
        online: device.online ?? false,
        on:     device.on     ?? null,
        level:  device.level  ?? null,
      },
      power,
      energy,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/devices/:id/color-temperature ───────────────────────────────────
// Returns CT range from capabilities cache. Current mireds/kelvin are delivered
// via WebSocket state_change events, not stored in Postgres — returned as null.
router.get("/api/devices/:id/color-temperature", async (req, res) => {
  const { id } = req.params;
  try {
    const caps = await dbService.getDeviceCapabilities(id);

    const minMireds = caps?.minMireds ?? null;
    const maxMireds = caps?.maxMireds ?? null;
    const minKelvin = maxMireds ? Math.round(1_000_000 / maxMireds) : null;
    const maxKelvin = minMireds ? Math.round(1_000_000 / minMireds) : null;

    res.json({
      nodeId:     id,
      mireds:     null, // live value — updated via WS state_change events
      kelvin:     null,
      minMireds,
      maxMireds,
      minKelvin,
      maxKelvin,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/devices/:id/name ───────────────────────────────────────────────
// Updates the device display name in Postgres only — no gateway round-trip needed.
router.patch("/api/devices/:id/name", async (req, res) => {
  const { id }   = req.params;
  const { name } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required and must be a non-empty string" });
    return;
  }

  try {
    await dbService.updateDeviceName(id, name.trim());
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export const apiRouter = router;
