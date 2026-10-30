-- Immutable transaction types distinguish personal obligations from company cash.
INSERT INTO transaction_types(transaction_type_id,transaction_type_name)
VALUES (2,'Admin payable added'),(3,'Admin payable paid');
INSERT INTO schema_version VALUES (11);
