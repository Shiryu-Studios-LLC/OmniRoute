-- Existing provider circuit-breaker state belongs to the platform tenant.
-- Future rows store a tenant-qualified name so the legacy table can keep its
-- current primary key while each tenant receives independent breaker state.
UPDATE domain_circuit_breakers
SET name = printf('%d:%s:%s', length('tenant_shiryu_admin'), 'tenant_shiryu_admin', name)
WHERE substr(
  name,
  1,
  length(printf('%d:%s:', length('tenant_shiryu_admin'), 'tenant_shiryu_admin'))
) != printf('%d:%s:', length('tenant_shiryu_admin'), 'tenant_shiryu_admin');
