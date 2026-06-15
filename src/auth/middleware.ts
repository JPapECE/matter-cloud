import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    console.error("[Auth] API_KEY environment variable is not set.");
    res.status(500).json({ error: "Internal server authentication misconfiguration" });
    return;
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: Missing Bearer token" });
    return;
  }

  const token = authHeader.substring(7).trim();
  if (token !== apiKey) {
    res.status(401).json({ error: "Unauthorized: Invalid API key" });
    return;
  }

  next();
}
