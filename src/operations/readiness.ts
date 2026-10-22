import {prisma} from '../prisma/runtime.js';
export async function assertFinancialSchemaReady(query:typeof prisma.$queryRaw=prisma.$queryRaw.bind(prisma)){
// A missing financial review schema is fatal; providers remaining unavailable are not.
await query`SELECT r."reviewRevision",a.id FROM "Refund" r LEFT JOIN "OperationalAudit" a ON false LIMIT 0`;
const [schema]=await query<Array<{ready:boolean}>>`SELECT to_regclass('"FbaOutbound_shipment_listing_key"') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='"Refund"'::regclass AND tgname='refund_review_revision' AND tgenabled IN ('O','A')) AS ready`;
if(!schema?.ready)throw new Error('Financial review schema not ready; migrate before starting');
}
