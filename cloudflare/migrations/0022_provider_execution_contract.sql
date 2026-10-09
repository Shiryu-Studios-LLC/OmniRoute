-- Explicit provider-account ownership and inference execution placement.
-- Existing rows represent customer-owned credentials sent to third-party provider endpoints.
ALTER TABLE provider_connections
  ADD COLUMN credential_ownership TEXT NOT NULL DEFAULT 'customer_managed'
    CHECK (credential_ownership IN ('customer_managed', 'shiryu_hosted', 'third_party'));
ALTER TABLE provider_connections
  ADD COLUMN execution_location TEXT NOT NULL DEFAULT 'third_party'
    CHECK (execution_location IN ('customer_environment', 'shiryu_hosted', 'third_party'));

ALTER TABLE provider_nodes
  ADD COLUMN credential_ownership TEXT NOT NULL DEFAULT 'customer_managed'
    CHECK (credential_ownership IN ('customer_managed', 'shiryu_hosted', 'third_party'));
ALTER TABLE provider_nodes
  ADD COLUMN execution_location TEXT NOT NULL DEFAULT 'third_party'
    CHECK (execution_location IN ('customer_environment', 'shiryu_hosted', 'third_party'));
