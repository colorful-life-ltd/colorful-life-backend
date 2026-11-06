// Synthetic populated upgrade only; refuses all non-owned/non-loopback connections.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl, databasePoolOptions } from "../src/config/database.ts";
if (
  process.env.LOCAL_DATABASE_REHEARSAL !== "true" ||
  process.env.DB_HOST !== "127.0.0.1" ||
  process.env.DB_NAME !== "colorful_life" ||
  process.env.DB_USER !== "cl_runtime" ||
  !process.env.DB_PORT ||
  process.env.DB_PORT === "5432"
)
  throw Error("Only the owned loopback runtime rehearsal is supported");
const [mode, file] = process.argv.slice(2);
if (!["seed", "verify"].includes(mode) || !file)
  throw Error("Explicit mode/file required");
const { prisma } = await import("../dist/prisma/runtime.js");
const db = new pg.Client(
  databasePoolOptions(databaseUrl(process.env), process.env),
);
try {
  await db.connect();
  assert.equal(
    (await db.query("SELECT current_user AS name")).rows[0].name,
    "cl_runtime",
  );
  if (mode === "seed") {
    assert.equal(
      (await db.query(`SELECT to_regclass('public."ReturnCase"') AS model`))
        .rows[0].model,
      null,
    );
    const user = await prisma.user.create({
      data: {
        email: `return-upgrade-${randomUUID()}@example.invalid`,
        passwordHash: "synthetic",
        role: "ADMIN",
        emailVerified: true,
      },
    });
    const product = await prisma.legoProduct.create({
      data: {
        setNumber: `RETURN-${randomUUID()}`,
        title: "Synthetic historic returns",
        theme: "TEST",
        ageRecommendation: "8+",
        pieceCount: 10,
      },
    });
    const listing = await prisma.productListing.create({
      data: {
        legoProductId: product.id,
        condition: "NEW",
        originalPrice: 10,
        currentStock: 6,
      },
    });
    const address = {
      RecipientName: "Synthetic Customer",
      Line1: "1 Synthetic Street",
      City: "Test",
      Postcode: "S63 8NS",
      CountryCode: "GB",
    };
    const addresses = Object.fromEntries(
      ["billing", "delivery"].flatMap((prefix) =>
        Object.entries(address).map(([key, v]) => [prefix + key, v]),
      ),
    );
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        status: "DISPATCHED",
        totalAmount: 50,
        ...addresses,
      },
      select: { id: true },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productListingId: listing.id,
        quantity: 5,
        unitPrice: 10,
        lineTotal: 50,
        returnedQuantity: 1,
        reservedReturnQuantity: 3,
      },
    });
    const ids = [];
    for (const status of ["REQUESTED", "AUTHORIZED", "RECEIVED", "COMPLETED"]) {
      const r = await prisma.orderReturn.create({
        data: {
          orderItemId: item.id,
          quantity: 1,
          reason: "CHANGE_OF_MIND",
          status,
          shippingPayer: "CUSTOMER",
          performedByUserId: user.id,
          ...(status === "COMPLETED"
            ? { restockQuantity: 1, condition: "AS_NEW" }
            : {}),
        },
        select: { id: true },
      });
      ids.push(r.id);
      if (status === "COMPLETED")
        await prisma.inventoryMovement.create({
          data: {
            listingId: listing.id,
            quantityChange: 1,
            type: "ORDER_RETURN",
            performedByUserId: user.id,
            note: `Completed order return ${r.id}`,
          },
        });
    }
    await prisma.inventoryMovement.create({
      data: {
        listingId: listing.id,
        quantityChange: -5,
        type: "WEBSITE_SALE",
        performedByUserId: user.id,
        note: `Order ${order.id} sale`,
      },
    });
    const rows = (
      await db.query(
        'SELECT * FROM "OrderReturn" WHERE id=ANY($1::int[]) ORDER BY id',
        [ids],
      )
    ).rows;
    writeFileSync(
      file,
      JSON.stringify({
        orderId: order.id,
        itemId: item.id,
        listingId: listing.id,
        rows,
        stock: 6,
      }),
    );
    console.log(
      "Synthetic historical requested/authorised/received/completed returns seeded as cl_runtime",
    );
  } else {
    const fixture = JSON.parse(readFileSync(file, "utf8")),
      rows = (
        await db.query(
          'SELECT * FROM "OrderReturn" WHERE id=ANY($1::int[]) ORDER BY id',
          [fixture.rows.map((r) => r.id)],
        )
      ).rows;
    const newKeys = [
      "submissionId",
      "instructions",
      "rejectionNote",
      "decisionByUserId",
      "receivedByUserId",
      "receiptNote",
    ];
    for (let i = 0; i < rows.length; i++) {
      const old = Object.fromEntries(
        Object.entries(rows[i]).filter(([key]) => !newKeys.includes(key)),
      );
      assert.deepEqual(JSON.parse(JSON.stringify(old)), fixture.rows[i]);
      assert.ok(rows[i].submissionId);
    }
    const cases = await prisma.returnCase.findMany({
      where: { orderId: fixture.orderId },
      include: { submissions: true },
    });
    assert.equal(cases.length, 1);
    assert.equal(cases[0].reference, `BB-R-${fixture.orderId}`);
    assert.equal(cases[0].submissions.length, 4);
    assert.equal(
      await prisma.orderConfirmationJob.count({
        where: { orderId: fixture.orderId },
      }),
      0,
    );
    const item = await prisma.orderItem.findUniqueOrThrow({
      where: { id: fixture.itemId },
    });
    assert.equal(item.returnedQuantity, 1);
    assert.equal(item.reservedReturnQuantity, 3);
    assert.equal(
      (
        await prisma.productListing.findUniqueOrThrow({
          where: { id: fixture.listingId },
        })
      ).currentStock,
      6,
    );
    for (const table of ["ReturnCase", "ReturnSubmission"])
      for (const verb of ["UPDATE", "DELETE"])
        assert.equal(
          (
            await db.query(
              "SELECT has_table_privilege(current_user,$1,$2) AS allowed",
              [`"${table}"`, verb],
            )
          ).rows[0].allowed,
          false,
        );
    assert.equal(
      (
        await db.query(
          `SELECT has_table_privilege(current_user,'"Order"','DELETE') AS allowed`,
        )
      ).rows[0].allowed,
      false,
    );
    console.log(
      "Populated return upgrade preserves all historic fields/counters/stock, creates one case/four submissions, sends no emails; runtime case/submission UPDATE/DELETE and Order DELETE remain denied: PASS",
    );
  }
} finally {
  await db.end();
  await prisma.$disconnect();
}
