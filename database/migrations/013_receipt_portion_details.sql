-- Extend only the receipt-specific table; transaction tables stay unchanged.
ALTER TABLE receipt_allocations ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details)='object');
ALTER TABLE receipt_allocations DROP CONSTRAINT receipt_allocations_kind_check;
ALTER TABLE receipt_allocations DROP CONSTRAINT receipt_allocations_check;
ALTER TABLE receipt_allocations ADD CONSTRAINT receipt_allocations_kind_check
    CHECK(kind IN ('receipt','return','contract','profit','details'));
ALTER TABLE receipt_allocations ADD CONSTRAINT receipt_allocations_check CHECK (
    (kind='receipt' AND receipt_key IS NOT NULL AND parent_receipt_id IS NULL AND version_id IS NULL AND position IS NULL AND contract_id IS NULL AND amount IS NULL) OR
    (kind='return' AND receipt_key IS NULL AND parent_receipt_id IS NOT NULL AND version_id IS NULL AND position IS NULL AND contract_id IS NULL AND amount IS NULL AND parent_receipt_id<>transaction_id) OR
    (kind IN ('contract','profit') AND receipt_key IS NULL AND parent_receipt_id IS NULL AND version_id IS NOT NULL AND position IS NOT NULL AND amount IS NOT NULL AND ((kind='contract')=(contract_id IS NOT NULL))) OR
    (kind='details' AND receipt_key IS NULL AND parent_receipt_id IS NULL AND version_id IS NOT NULL AND position=200 AND contract_id IS NULL AND amount IS NULL)
);
INSERT INTO schema_version VALUES (13);
