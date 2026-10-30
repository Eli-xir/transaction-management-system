-- Receipt-specific data lives in one new table; existing domain tables are unchanged.
CREATE TABLE receipt_allocations (
    record_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id integer NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    version_id integer REFERENCES transaction_versions(version_id) ON DELETE CASCADE,
    position integer CHECK(position>=0),
    kind text NOT NULL CHECK(kind IN ('receipt','return','contract','profit')),
    receipt_key varchar(8) UNIQUE CHECK(receipt_key ~ '^[A-Z0-9]{8}$'),
    parent_receipt_id integer REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
    contract_id uuid REFERENCES contracts(contract_id) ON DELETE RESTRICT,
    contract_name text NOT NULL DEFAULT '',
    amount numeric(18,2) CHECK(amount>0),
    UNIQUE(version_id,position),
    CHECK (
        (kind='receipt' AND receipt_key IS NOT NULL AND parent_receipt_id IS NULL AND version_id IS NULL AND position IS NULL AND contract_id IS NULL AND amount IS NULL) OR
        (kind='return' AND receipt_key IS NULL AND parent_receipt_id IS NOT NULL AND version_id IS NULL AND position IS NULL AND contract_id IS NULL AND amount IS NULL AND parent_receipt_id<>transaction_id) OR
        (kind IN ('contract','profit') AND receipt_key IS NULL AND parent_receipt_id IS NULL AND version_id IS NOT NULL AND position IS NOT NULL AND amount IS NOT NULL AND ((kind='contract')=(contract_id IS NOT NULL)))
    )
);
CREATE UNIQUE INDEX receipt_metadata_transaction_idx ON receipt_allocations(transaction_id) WHERE kind IN ('receipt','return');
CREATE INDEX receipt_allocations_contract_idx ON receipt_allocations(contract_id);
CREATE INDEX receipt_allocations_parent_idx ON receipt_allocations(parent_receipt_id);
DO $$
DECLARE entry record; candidate varchar(8);
BEGIN
    FOR entry IN SELECT transaction_id FROM transactions WHERE credit_user_id IS NOT NULL LOOP
        LOOP
            candidate := upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
            EXIT WHEN NOT EXISTS (SELECT 1 FROM receipt_allocations WHERE receipt_key=candidate);
        END LOOP;
        INSERT INTO receipt_allocations(transaction_id,kind,receipt_key) VALUES(entry.transaction_id,'receipt',candidate);
    END LOOP;
END $$;
INSERT INTO receipt_allocations(transaction_id,version_id,position,kind,contract_id,contract_name,amount)
SELECT v.transaction_id,v.version_id,0,'contract',v.contract_id,v.contract_name,v.transaction_amount
FROM transaction_versions v JOIN transactions t USING(transaction_id)
WHERE t.credit_user_id IS NOT NULL AND v.contract_id IS NOT NULL AND v.transaction_amount>0;
INSERT INTO schema_version VALUES (12);
