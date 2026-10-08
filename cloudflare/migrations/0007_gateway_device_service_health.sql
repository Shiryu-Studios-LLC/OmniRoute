-- Sanitized, endpoint-free Local Agent reachability flags.
ALTER TABLE cloud_gateway_devices
  ADD COLUMN service_health_json TEXT;
