import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import express from "express";
import { paypalWebhookHandler } from "../controllers/paypalWebhookController.js";
const router = Router();
// Keep parser errors local and sanitized; Express's default error logger must
// not receive request bodies or provider signature material.
const parserError: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error?.status === 413 ? 413 : error?.status === 415 ? 415 : 400;
  res.status(status).json({ error: "Invalid webhook body" });
};
const requireJson: RequestHandler = (req, res, next) => {
  const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(req.headers['content-type'] ?? '')?.[1];
  if (!req.is('application/json') || (charset && charset.toLowerCase() !== 'utf-8')) {
    res.status(415).json({ error: "Unsupported webhook body" }); return;
  }
  next();
};
router.post("/paypal/webhook", requireJson, express.raw({ type: "application/json", inflate: false, limit: "100kb" }), paypalWebhookHandler, parserError);
export default router;
