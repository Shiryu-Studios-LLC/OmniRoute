-- Invalidate pending bootstrap codes issued before subject binding is enforced.
DELETE FROM cloud_tenant_oidc_owner_claims;

-- Bind future enrollment credentials to the exact OIDC subject selected by the
-- customer's identity administrator before the claim is issued.
ALTER TABLE cloud_tenant_oidc_owner_claims
  ADD COLUMN expected_subject TEXT NOT NULL
  CHECK (length(expected_subject) BETWEEN 1 AND 512);
