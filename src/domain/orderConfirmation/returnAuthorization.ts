import { z } from "zod";
import {
  escapeHtml,
  Images,
  button,
  renderBrandedEmail,
  legalDisclosure,
} from "../email/brandEmail.js";
import type { Business } from "./contract.js";
import { customerOrderUrl } from "./delivery.js";
export const returnAuthorizationSchema = z
  .object({
    version: z.literal(1),
    orderId: z.number().int().positive(),
    returnId: z.number().int().positive(),
    reference: z.string().min(1),
    recipientEmail: z.email(),
    quantity: z.number().int().positive(),
    itemName: z.string().min(1),
    address: z.array(z.string().min(1)).min(1),
    instructions: z.string().min(1),
    postageInstructions: z.string().min(1),
    shippingPayer: z.enum(["CUSTOMER", "SELLER"]),
  })
  .strict();
export function renderReturnAuthorization(value: unknown, business: Business) {
  const p = returnAuthorizationSchema.parse(value),
    url = customerOrderUrl(p.orderId);
  const subject = `Your Build & Bloom return ${p.reference} is authorised`;
  const text = [
    subject,
    `Original order #${p.orderId}`,
    `Return line #${p.returnId}: ${p.itemName} × ${p.quantity}`,
    "Return address:",
    ...p.address,
    p.instructions,
    `Return postage: ${p.shippingPayer === "SELLER" ? "paid by Colorful Life Ltd" : "paid by you"}`,
    p.postageInstructions,
    "Receipt does not automatically issue a refund. Your statutory rights are unaffected.",
    ...(url ? [`View your return: ${url}`] : []),
    `Questions: ${business.replyToEmail}`,
    ...legalDisclosure(business),
  ].join("\n");
  return {
    subject,
    text,
    html: renderBrandedEmail({
      title: subject,
      preheader: `Return instructions for ${p.reference}`,
      hero: "dispatch",
      images: new Images(false),
      heading: "Your return is authorised",
      subheading: `${p.reference} · Order #${p.orderId}`,
      body:
        text
          .split("\n")
          .slice(1, -legalDisclosure(business).length)
          .map((line) => `<p>${escapeHtml(line)}</p>`)
          .join("") + button("View your return", url),
      footerLinks: [],
      legalLines: legalDisclosure(business),
    }),
  };
}
