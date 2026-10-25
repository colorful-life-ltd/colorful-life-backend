import {customerLimits,normalizePostcode,validPostcode,validPhone} from "../utils/customerInput.js";
import {logOperationalError} from "../utils/operationalLog.js";
import { Request, Response } from "express";
import { prisma } from "../prisma/runtime.js";
import { Prisma } from "../generated/prisma-client/client.js";
import { z } from "zod";
import { lookupUkAddresses, AddressLookupProviderError } from "../services/addressLookupService.js";
import { AddressLookupQuerySchema } from "../utils/addressValidation.js";
import { consumeAddressLookupAllowance } from "../services/addressLookupRateLimiter.js";
import { normalizeCountryCode } from "../domain/addresses/countryCode.js";

// ---------------------------------------------------------------------------
// Address API shapes and helpers
// ---------------------------------------------------------------------------
type AddressOutput = {
  id: number;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  postcode: string;
  country: string;
  phone: string | null;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
};

// Prisma projection used throughout the file when querying addresses
type AddressSelect = {
  id: number;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  postcode: string;
  countryCode: string;
  phone: string | null;
  isDefault: boolean;
  isDefaultBilling: boolean;
};

/**
 * Map the Prisma.Address model to the API representation.
 */
function mapAddressToApi(addr: AddressSelect): AddressOutput {
  return {
    id: addr.id,
    recipientName: addr.recipientName,
    line1: addr.line1,
    line2: addr.line2 ?? null,
    city: addr.city,
    postcode: addr.postcode,
    country: addr.countryCode,
    phone: addr.phone ?? null,
    isDefaultShipping: addr.isDefault,
    isDefaultBilling: addr.isDefaultBilling ?? false,
  };
}

/** Serialize every address mutation on the stable owner row, including an empty address book. */
async function lockAddressOwner(tx: Prisma.TransactionClient, userId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

class DuplicateAddress extends Error {}
function addressIdentity(a: {recipientName:string;line1:string;line2?:string|null;city:string;postcode:string;countryCode:string}) {
 return JSON.stringify([a.recipientName,a.line1,a.line2??'',a.city,normalizePostcode(a.postcode),a.countryCode].map(v=>v.trim().replace(/\s+/g,' ').toLowerCase()));
}
async function rejectDuplicate(tx: Prisma.TransactionClient,userId:number,candidate: Parameters<typeof addressIdentity>[0],exceptId?:number) {
 const addresses=await tx.address.findMany({where:{userId}});
 if(addresses.some(a=>a.id!==exceptId&&addressIdentity(a)===addressIdentity(candidate)))throw new DuplicateAddress();
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
// Stored as an ISO code: order snapshots and invoices reject display names.
const CountrySchema = z.string().trim().min(1, { message: "country cannot be empty" }).transform((value, ctx) => {
  const code = normalizeCountryCode(value);
  if (code !== "GB") { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only United Kingdom addresses are supported" }); return z.NEVER; }
  return code;
});

const CreateAddressSchema = z.object({
  recipientName: z.string().trim().min(1, { message: "recipientName cannot be empty" }).max(customerLimits.recipientName),
  line1: z.string().trim().min(1, { message: "line1 cannot be empty" }).max(customerLimits.line1),
  city: z.string().trim().min(1, { message: "city cannot be empty" }).max(customerLimits.city),
  postcode: z.string().transform(normalizePostcode).pipe(z.string().min(1, { message: "postcode cannot be empty" }).max(customerLimits.postcode).refine(validPostcode, "Enter a valid UK postcode")),
  country: CountrySchema,
  line2: z.string().trim().max(customerLimits.line2).nullable().optional(),
  phone: z.string().trim().max(customerLimits.phone).refine(validPhone, "Enter a valid UK phone number").nullable().optional(),
  isDefaultShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
});

const PatchAddressSchema = z.object({
  recipientName: z.string().trim().min(1).max(customerLimits.recipientName).optional(),
  line1: z.string().trim().min(1).max(customerLimits.line1).optional(),
  city: z.string().trim().min(1).max(customerLimits.city).optional(),
  postcode: z.string().transform(normalizePostcode).pipe(z.string().min(1).max(customerLimits.postcode).refine(validPostcode, "Enter a valid UK postcode")).optional(),
  country: CountrySchema.optional(),
  line2: z.string().trim().max(customerLimits.line2).nullable().optional(),
  phone: z.string().trim().max(customerLimits.phone).refine(validPhone, "Enter a valid UK phone number").nullable().optional(),
  isDefaultShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "No fields provided for update",
});

export const lookupAddresses = async (req: Request, res: Response) => {
  const parseResult = AddressLookupQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!consumeAddressLookupAllowance(userId)) {
    return res.status(429).json({ error: "Address lookup rate limit exceeded" });
  }
  try {
    const addresses = await lookupUkAddresses(parseResult.data.postcode);
    return res.json({ addresses });
  } catch (error) {
    if (error instanceof AddressLookupProviderError) {
      return res.status(503).json({ error: "Address lookup service unavailable" });
    }
    logOperationalError("Address lookup error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /users/me/addresses
// ---------------------------------------------------------------------------
export const getAddresses = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const addresses = await prisma.address.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        recipientName: true,
        line1: true,
        line2: true,
        city: true,
        postcode: true,
        countryCode: true,
        phone: true,
        isDefault: true,
        isDefaultBilling: true,
      },
    });
    const response = addresses.map(mapAddressToApi);
    return res.json(response);
  } catch (err) {
    logOperationalError("Get addresses error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /users/me/addresses
// ---------------------------------------------------------------------------
export const createAddress = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const parseResult = CreateAddressSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const data = parseResult.data;
  try {
    const created = await prisma.$transaction(async (tx) => {
      await lockAddressOwner(tx, userId);
      await rejectDuplicate(tx,userId,{...data,countryCode:data.country});
      const addressCount = await tx.address.count({ where: { userId } });
      const isFirst = addressCount === 0;
      let isDefaultShipping = data.isDefaultShipping ?? false;
      let isDefaultBilling = data.isDefaultBilling ?? false;
      if (isFirst) {
        isDefaultShipping = true;
        isDefaultBilling = true;
      }
      if (isDefaultShipping) {
        await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      }
      if (isDefaultBilling) {
        await tx.address.updateMany({ where: { userId, isDefaultBilling: true }, data: { isDefaultBilling: false } });
      }
      const createData: Prisma.AddressCreateInput = {
        user: { connect: { id: userId } },
        recipientName: data.recipientName,
        line1: data.line1,
        line2: data.line2 ?? null,
        city: data.city,
        postcode: data.postcode,
        countryCode: data.country,
        phone: data.phone ?? null,
        isDefault: isDefaultShipping,
        isDefaultBilling,
      };
      const addr = await tx.address.create({ data: createData });
      return addr;
    });
    return res.status(201).json(mapAddressToApi(created));
  } catch (err) {
    if(err instanceof DuplicateAddress)return res.status(409).json({error:"This recipient and address are already saved."});
    logOperationalError("Create address error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /users/me/addresses/:addressId
// ---------------------------------------------------------------------------
export const updateAddress = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const addressId = Number(req.params.addressId);
  if (!Number.isInteger(addressId) || addressId < 1) {
    return res.status(400).json({ error: "Invalid address id" });
  }
  const parseResult = PatchAddressSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const data = parseResult.data;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockAddressOwner(tx, userId);
      const address = await tx.address.findFirst({
        where: { id: addressId, userId },
        select: { id: true, userId: true, isDefault: true, isDefaultBilling: true, recipientName:true,line1:true,line2:true,city:true,postcode:true,countryCode:true },
      });
      if (!address) {
        return null;
      }
      await rejectDuplicate(tx,userId,{...address,...data,countryCode:data.country??address.countryCode},addressId);
      // Reject the complete request before clearing either role. Returning a
      // rejection from a transaction callback commits any preceding writes.
      if (data.isDefaultShipping === false && address.isDefault) {
        return "cannot_unset_shipping_default";
      }
      if (data.isDefaultBilling === false && address.isDefaultBilling) {
        return "cannot_unset_billing_default";
      }
      const updateData: Prisma.AddressUpdateInput = {};
      if (data.recipientName !== undefined) updateData.recipientName = data.recipientName;
      if (data.line1 !== undefined) updateData.line1 = data.line1;
        if (data.line2 !== undefined) updateData.line2 = data.line2 ?? null;
        if (data.city !== undefined) updateData.city = data.city;
        if (data.postcode !== undefined) updateData.postcode = data.postcode;
        if (data.country !== undefined) updateData.countryCode = data.country;
        if (data.phone !== undefined) updateData.phone = data.phone ?? null;
      if (data.isDefaultShipping !== undefined) {
        if (data.isDefaultShipping) {
          await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
          updateData.isDefault = true;
        }
      }
      if (data.isDefaultBilling !== undefined) {
        if (data.isDefaultBilling) {
          await tx.address.updateMany({ where: { userId, isDefaultBilling: true }, data: { isDefaultBilling: false } });
          updateData.isDefaultBilling = true;
        }
      }
      const updatedAddr = await tx.address.update({ where: { id: addressId }, data: updateData, select: { id: true, recipientName: true, line1: true, line2: true, city: true, postcode: true, countryCode: true, phone: true, isDefault: true, isDefaultBilling: true } });
      return updatedAddr;
    });
    if (result === null) {
      return res.status(404).json({ error: "Address not found" });
    }
    if (result === "cannot_unset_shipping_default") {
      return res.status(400).json({ error: "Cannot directly unset the default shipping address" });
    }
    if (result === "cannot_unset_billing_default") {
      return res.status(400).json({ error: "Cannot directly unset the default billing address" });
    }
    return res.json(mapAddressToApi(result));
  } catch (err) {
    if(err instanceof DuplicateAddress)return res.status(409).json({error:"This recipient and address are already saved."});
    logOperationalError("Update address error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /users/me/addresses/:addressId
// ---------------------------------------------------------------------------
export const deleteAddress = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const addressId = Number(req.params.addressId);
  if (!Number.isInteger(addressId) || addressId < 1) {
    return res.status(400).json({ error: "Invalid address id" });
  }
  try {
    const deleted = await prisma.$transaction(async (tx) => {
      await lockAddressOwner(tx, userId);
      const address = await tx.address.findFirst({ where: { id: addressId, userId }, select: { id: true, userId: true, isDefault: true, isDefaultBilling: true } });
      if (!address) {
        return false;
      }
      const { isDefault, isDefaultBilling } = address;
      const remaining = await tx.address.findMany({ where: { userId, id: { not: addressId } }, orderBy: { id: "asc" } });
      if (remaining.length > 0) {
        const promote = remaining[0];
        const promoteData: Prisma.AddressUpdateInput = {};
        if (isDefault) promoteData.isDefault = true;
        if (isDefaultBilling) promoteData.isDefaultBilling = true;
        await tx.address.update({ where: { id: promote.id }, data: promoteData });
      }
      await tx.address.delete({ where: { id: addressId } });
      return true;
    });
    if (!deleted) {
      return res.status(404).json({ error: "Address not found" });
    }
    return res.status(204).send();
  } catch (err) {
    logOperationalError("Delete address error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
