-- Issue #185: owner-approved first invoice sequence value 102801 (BB-00102801 with prefix BB, 8 digits).
-- Forward-only: the sequence is advanced only when its next value would be lower than 102801.
-- A live sequence is never reset or moved backwards, existing invoices are not touched, and no
-- invoice rows are created. Numbers stay unique (UNIQUE "invoiceNumber") and immutable.
DO $$
DECLARE next_value BIGINT;
BEGIN
  SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END INTO next_value FROM "commercial_invoice_number_seq";
  IF next_value < 102801 THEN
    PERFORM setval('"commercial_invoice_number_seq"'::regclass, 102800, true);
  END IF;
END $$;
