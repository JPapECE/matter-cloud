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
    const nodeId = await commandDispatcher.dispatch("commission", undefined, {
      pairingCode,
      name,
      type: type || "smart-plug",
      wifi,
    });
    res.status(201).json({ nodeId, success: true });
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

export const apiRouter = router;
