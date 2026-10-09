import type { CloudDb, CloudDbStatement } from "./db";
import { normalizeCustomerHostname } from "./tenantHosts";

export interface CloudFrontDeskConfig {
  hostname: string;
  tenantId: string;
  customerApiKeyEncrypted: string;
  dashboardTokenEncrypted: string;
  gatewayBaseUrl: string;
  deviceId: string;
  ollamaModel: string;
  imageGenerationJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudFrontDeskConfigUpsertInput {
  hostname: string;
  tenantId: string;
  customerApiKeyEncrypted: string;
  dashboardTokenEncrypted: string;
  gatewayBaseUrl: string;
  deviceId: string;
  ollamaModel: string;
  imageGenerationJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FrontDeskConfigRow {
  hostname: string;
  tenant_id: string;
  customer_api_key_encrypted: string;
  dashboard_token_encrypted: string;
  gateway_base_url: string;
  device_id: string;
  ollama_model: string;
  image_generation_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapFrontDeskConfig(row: FrontDeskConfigRow): CloudFrontDeskConfig {
  return {
    hostname: row.hostname,
    tenantId: row.tenant_id,
    customerApiKeyEncrypted: row.customer_api_key_encrypted,
    dashboardTokenEncrypted: row.dashboard_token_encrypted,
    gatewayBaseUrl: row.gateway_base_url,
    deviceId: row.device_id,
    ollamaModel: row.ollama_model,
    imageGenerationJson: row.image_generation_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCloudFrontDeskConfig(
  db: CloudDb,
  hostnameValue: string
): Promise<CloudFrontDeskConfig | null> {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) return null;
  const row = await db
    .prepare<FrontDeskConfigRow>(
      `SELECT hostname, tenant_id, customer_api_key_encrypted, dashboard_token_encrypted,
              gateway_base_url, device_id, ollama_model, image_generation_json,
              created_at, updated_at
         FROM cloud_frontdesk_configs
        WHERE hostname = ?
        LIMIT 1`
    )
    .bind(hostname)
    .first<FrontDeskConfigRow>();
  return row ? mapFrontDeskConfig(row) : null;
}

export async function listCloudFrontDeskConfigs(
  db: CloudDb,
  tenantId: string
): Promise<CloudFrontDeskConfig[]> {
  const result = await db
    .prepare<FrontDeskConfigRow>(
      `SELECT hostname, tenant_id, customer_api_key_encrypted, dashboard_token_encrypted,
              gateway_base_url, device_id, ollama_model, image_generation_json,
              created_at, updated_at
         FROM cloud_frontdesk_configs
        WHERE tenant_id = ?
        ORDER BY hostname`
    )
    .bind(tenantId)
    .all<FrontDeskConfigRow>();
  if (!result.success) throw new Error("D1 Front Desk config list failed");
  return result.results.map(mapFrontDeskConfig);
}

export function prepareUpsertCloudFrontDeskConfig(
  db: CloudDb,
  input: CloudFrontDeskConfigUpsertInput
): CloudDbStatement {
  const hostname = normalizeCustomerHostname(input.hostname);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  return db
    .prepare(
      `INSERT INTO cloud_frontdesk_configs
         (hostname, tenant_id, customer_api_key_encrypted, dashboard_token_encrypted,
          gateway_base_url, device_id, ollama_model, image_generation_json,
          created_at, updated_at)
       SELECT h.hostname, h.tenant_id, ?, ?, ?, ?, ?, ?, ?, ?
         FROM cloud_verified_customer_hosts h
        WHERE h.hostname = ? AND h.tenant_id = ?
       ON CONFLICT(hostname) DO UPDATE SET
         customer_api_key_encrypted = excluded.customer_api_key_encrypted,
         dashboard_token_encrypted = excluded.dashboard_token_encrypted,
         gateway_base_url = excluded.gateway_base_url,
         device_id = excluded.device_id,
         ollama_model = excluded.ollama_model,
         image_generation_json = excluded.image_generation_json,
         updated_at = excluded.updated_at
       WHERE cloud_frontdesk_configs.tenant_id = excluded.tenant_id`
    )
    .bind(
      input.customerApiKeyEncrypted,
      input.dashboardTokenEncrypted,
      input.gatewayBaseUrl,
      input.deviceId,
      input.ollamaModel,
      input.imageGenerationJson,
      input.createdAt,
      input.updatedAt,
      hostname,
      input.tenantId
    );
}

export async function upsertCloudFrontDeskConfig(
  db: CloudDb,
  input: CloudFrontDeskConfigUpsertInput
): Promise<boolean> {
  const result = await prepareUpsertCloudFrontDeskConfig(db, input).run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

export function prepareDeleteCloudFrontDeskConfig(
  db: CloudDb,
  hostnameValue: string
): CloudDbStatement {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  return db.prepare("DELETE FROM cloud_frontdesk_configs WHERE hostname = ?").bind(hostname);
}

export async function deleteCloudFrontDeskConfig(
  db: CloudDb,
  hostnameValue: string
): Promise<boolean> {
  const result = await prepareDeleteCloudFrontDeskConfig(db, hostnameValue).run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}
