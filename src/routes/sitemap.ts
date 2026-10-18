import {logOperationalError} from "../utils/operationalLog.js";
import { Router, type Response } from "express";
import { config } from "../config/index.js";
import { parsePublicSiteOrigin } from "../domain/seo/publicSiteOrigin.js";
import { createSitemapService } from "../domain/seo/sitemapService.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

/**
 * Public sitemap endpoints. URLs use PUBLIC_SITE_URL, never the request or API
 * host; without it the sitemap is unavailable rather than guessed.
 */
export function createSitemapRouter(options: { siteUrl?: string; maxUrlsPerSitemap?: number } = {}) {
  const router = Router();
  const configured = options.siteUrl ?? config.PUBLIC_SITE_URL;
  const siteOrigin = configured ? parsePublicSiteOrigin(configured) : null;
  const service = siteOrigin ? createSitemapService({ siteOrigin, maxUrlsPerSitemap: options.maxUrlsPerSitemap }) : null;

  const sendXml = (res: Response, xml: string) => res
    .status(200)
    .type("application/xml; charset=utf-8")
    .set("Cache-Control", "public, max-age=3600")
    .send(xml);

  router.get("/sitemap.xml", async (_req, res) => {
    if (!service) return sendApiError(res, 503, "SITEMAP_UNAVAILABLE", "Sitemap is unavailable: PUBLIC_SITE_URL is not configured");
    try {
      return sendXml(res, (await service.root()).xml);
    } catch (error) {
      logOperationalError("Sitemap generation error", error);
      return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
    }
  });

  router.get(/^\/sitemap-([1-9]\d{0,5})\.xml$/, async (req, res) => {
    if (!service) return sendApiError(res, 503, "SITEMAP_UNAVAILABLE", "Sitemap is unavailable: PUBLIC_SITE_URL is not configured");
    try {
      const xml = await service.page(Number(req.params[0]));
      return xml === null ? sendApiError(res, 404, "NOT_FOUND", "Sitemap not found") : sendXml(res, xml);
    } catch (error) {
      logOperationalError("Sitemap generation error", error);
      return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
    }
  });

  return router;
}
