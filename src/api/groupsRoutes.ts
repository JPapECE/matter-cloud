/**
 * groupsRoutes.ts
 * Groups cache and control REST API router.
 */

import { Router } from "express";
import { dbService } from "../database/DatabaseService.js";
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

// groupId validator
function parseGroupId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (Number.isNaN(id) || id < 1 || id > 0xFFF7) return null;
  return id;
}

// Enforce auth on all endpoints below
router.use(requireAuth);

// ── GET /api/groups ──────────────────────────────────────────────────────────
router.get("/api/groups", async (_req, res) => {
  try {
    const groups = await dbService.getAllGroups();
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/groups ─────────────────────────────────────────────────────────
router.post("/api/groups", async (req, res) => {
  const { groupId, name } = req.body;
  const parsedId = typeof groupId === "number" ? groupId : parseGroupId(String(groupId));

  if (parsedId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527 (0x0001-0xFFF7)" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    // Dispatch create_group to gateway and await confirmation
    await commandDispatcher.dispatch("create_group", undefined, { groupId: parsedId, name });
    await dbService.createGroup(parsedId, name);
    res.status(201).json({ groupId: parsedId, name, members: [] });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── GET /api/groups/:groupId ─────────────────────────────────────────────────
router.get("/api/groups/:groupId", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    const group = await dbService.getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: `Group ${groupId} not found` });
      return;
    }
    res.json(group);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/groups/:groupId/name ──────────────────────────────────────────
router.patch("/api/groups/:groupId/name", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  const { name } = req.body;

  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    await commandDispatcher.dispatch("rename_group", undefined, { groupId, name });
    await dbService.updateGroupName(groupId, name);
    res.json({ success: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── DELETE /api/groups/:groupId ──────────────────────────────────────────────
router.delete("/api/groups/:groupId", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    await commandDispatcher.dispatch("delete_group", undefined, { groupId });
    await dbService.deleteGroup(groupId);
    res.json({ success: true, removed: groupId });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── POST /api/groups/:groupId/members/:nodeId ───────────────────────────────
router.post("/api/groups/:groupId/members/:nodeId", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  const { nodeId } = req.params;

  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    await commandDispatcher.dispatch("add_group_member", undefined, { groupId, nodeId });
    await dbService.addGroupMember(groupId, nodeId);
    res.status(201).json({ groupId, nodeId, added: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── DELETE /api/groups/:groupId/members/:nodeId ─────────────────────────────
router.delete("/api/groups/:groupId/members/:nodeId", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  const { nodeId } = req.params;

  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    await commandDispatcher.dispatch("remove_group_member", undefined, { groupId, nodeId });
    await dbService.removeGroupMember(groupId, nodeId);
    res.json({ groupId, nodeId, removed: true });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── Group Control commands ───────────────────────────────────────────────────

router.post("/api/groups/:groupId/on", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    const data = await commandDispatcher.dispatch("group_on", undefined, { groupId });
    res.json({ ok: true, groupId, ...data });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/groups/:groupId/off", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    const data = await commandDispatcher.dispatch("group_off", undefined, { groupId });
    res.json({ ok: true, groupId, ...data });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/groups/:groupId/toggle", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    const data = await commandDispatcher.dispatch("group_toggle", undefined, { groupId });
    res.json({ ok: true, groupId, ...data });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/groups/:groupId/level", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  const { level, transitionTime } = req.body;

  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }
  if (typeof level !== "number" || level < 1 || level > 254) {
    res.status(400).json({ error: "level must be an integer between 1 and 254" });
    return;
  }

  try {
    const data = await commandDispatcher.dispatch("group_level", undefined, { groupId, level, transitionTime });
    res.json({ ok: true, groupId, level, ...data });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

router.post("/api/groups/:groupId/color-temperature", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  let { mireds, kelvin, transitionTime } = req.body;

  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }
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
    const data = await commandDispatcher.dispatch("group_color_temperature", undefined, { groupId, mireds, transitionTime });
    res.json({ ok: true, groupId, mireds, ...data });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

// ── GET /api/groups/:groupId/membership/:nodeId ──────────────────────────────
router.get("/api/groups/:groupId/membership/:nodeId", async (req, res) => {
  const groupId = parseGroupId(req.params.groupId);
  const { nodeId } = req.params;

  if (groupId === null) {
    res.status(400).json({ error: "groupId must be an integer 1-65527" });
    return;
  }

  try {
    const data = await commandDispatcher.dispatch("get_device_group_membership", nodeId);
    res.json({
      nodeId,
      groupId,
      isMember: data.allGroups.includes(groupId),
      capacity: data.capacity,
      allGroups: data.allGroups,
    });
  } catch (err: any) {
    handleCommandError(err, res);
  }
});

export const groupsRouter = router;
