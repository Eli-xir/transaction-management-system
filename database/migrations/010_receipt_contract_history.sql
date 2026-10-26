ALTER TABLE transaction_versions ADD COLUMN contract_id uuid REFERENCES contracts;
ALTER TABLE transaction_versions ADD COLUMN contract_name text NOT NULL DEFAULT '';
-- Attribution was immutable before this migration, so all existing versions
-- of an attributed receipt belonged to its current contract.
UPDATE transaction_versions v SET contract_id=t.contract_id, contract_name=c.name
FROM transactions t JOIN contracts c ON c.contract_id=t.contract_id
WHERE v.transaction_id=t.transaction_id;
INSERT INTO schema_version VALUES (10);
