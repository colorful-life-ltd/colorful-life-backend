-- Issue #185: owner-approved first invoice sequence value 102801 (BB-00102801 with prefix BB, 8 digits).
-- Forward-only: the sequence is advanced only when its next value would be lower than 102801.
-- A live sequence is never reset or moved backwards, existing invoices are not touched, and no
-- invoice rows are created. Numbers stay unique (UNIQUE "invoiceNumber") and immutable.
--
-- Concurrency: sequences cannot be locked with LOCK TABLE, and nextval() holds ROW EXCLUSIVE on the
-- sequence until its transaction ends. A no-op ALTER SEQUENCE takes SHARE ROW EXCLUSIVE, which
-- conflicts with it: it waits for in-flight allocating transactions to commit and blocks new
-- nextval() calls until this statement's transaction ends, so the read/check/set below is atomic
-- with respect to invoice issuing. lock_timeout makes the deploy fail instead of queueing behind a
-- long transaction; re-running the migration is safe.
DO $$
DECLARE next_value BIGINT; step BIGINT;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  SELECT increment_by INTO step FROM pg_sequences WHERE schemaname = current_schema() AND sequencename = 'commercial_invoice_number_seq';
  IF step IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'commercial_invoice_number_seq must have INCREMENT BY 1 (found %)', step;
  END IF;
  ALTER SEQUENCE "commercial_invoice_number_seq" INCREMENT BY 1;
  SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END INTO next_value FROM "commercial_invoice_number_seq";
  IF next_value < 102801 THEN
    PERFORM setval('"commercial_invoice_number_seq"'::regclass, 102800, true);
  END IF;
END $$;
