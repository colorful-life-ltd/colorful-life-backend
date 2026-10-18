import {createHash} from "node:crypto";
import type {Prisma} from "../../generated/prisma-client/client.js";
/** Audit annotations never constitute provider financial proof. */
export async function journalRefundEvidence(tx: Prisma.TransactionClient, refundId: number, evidence: Prisma.InputJsonValue) {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    const hash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    const key = `refund-evidence:${refundId}:${hash}`;
    const rows = await tx.$queryRaw<Array<{
        id: bigint;
    }>> `INSERT INTO "OperationalAudit" (kind,"orderId","refundId",details,"requestKey")
    VALUES ('REFUND_EVIDENCE',${refund.orderId},${refundId},${JSON.stringify(evidence)}::jsonb,${key})
    ON CONFLICT ("requestKey") DO NOTHING RETURNING id`;
    return rows.length > 0;
}
/** Bounded identity/amount diagnostics only. Never retain provider payloads or metadata. */
export function refundConflictEvidence(issue:string,source:'POST'|'GET',fields:Record<string,unknown>){
 const result:Record<string,string|number>={issue,source};
 for(const [key,value] of Object.entries(fields)){
  if(typeof value==='number'&&Number.isFinite(value))result[key]=value;
  else if(typeof value==='string')result[key]=/^[A-Za-z0-9_.:-]{1,256}$/.test(value)?value:'INVALID';
  else if(value!==undefined&&value!==null)result[key]='INVALID';
 }
 return result;
}
